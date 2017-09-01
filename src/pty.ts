import * as I from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import {Socket} from 'net';
import {Termios, ICTermios} from 'node-termios';
import {EventEmitter} from 'events';
import * as cp from 'child_process';
import * as tty from 'tty';
import {Duplex} from "stream";
import {Readable} from "stream";
import {Writable} from "stream";

// cant import ReadStream?
const ReadStream = require('tty').ReadStream;

// native module
export const native: I.Native = require(path.join('..', 'build', 'Release', 'pty.node'));

// default terminal size
export const DEFAULT_COLS: number = 80;
export const DEFAULT_ROWS: number = 24;

// helper applications
export const HELPER: string = path.join(__dirname, '..', 'build', 'Release', 'helper');
export const STDERR_TESTER: string = path.join(__dirname, '..', 'build', 'Release', 'stderr_tester');


/**
 * openpty - open a new pty device.
 * @param opts
 * @return {{master: number, slave: number, slavepath: string}}
 */
export function openpty(opts?: I.OpenPtyOptions): I.NativePty {
    // get a pty master
    let master = native.openpt(native.FD_FLAGS.O_RDWR | native.FD_FLAGS.O_NOCTTY);

    // grant and unlock
    native.grantpt(master);
    native.unlockpt(master);

    // open slave side
    let slavepath: string = native.ptsname(master);
    let slave: number = fs.openSync(slavepath, native.FD_FLAGS.O_RDWR | native.FD_FLAGS.O_NOCTTY);
    // solaris has to load extra drivers on the slave fd to get terminal semantics
    native.load_driver(slave);

    // apply termios settings
    (new Termios((opts) ? opts.termios : null)).writeTo(slave);

    // apply size settings
    let cols: number = (opts && opts.size) ? opts.size.cols || DEFAULT_COLS : DEFAULT_COLS;
    let rows: number = (opts && opts.size) ? opts.size.rows || DEFAULT_ROWS : DEFAULT_ROWS;
    native.set_size(master, cols, rows);

    return {master: master, slave: slave, slavepath: slavepath};
}


/**
 * RawPty - class to hold a pty device.
 *
 * Main purpose of this class is to encapsulate termios settings,
 * size settings and the file descriptor handling in a platform
 * independent way.
 *
 * Access the file descriptors via their getters (`master_fd` and `slave_fd`)
 * to spot changes of the state correctly (-1 for illegal).
 *
 * NOTE: The slave side of a pty can be opened several times
 * across different processes. This usually happens by opening
 * the slave pathname (`slavepath`).
 * The master is more restrictive (e.g. not allowed to be duped on some OS).
 * Once the master end is closed a pty is not usable anymore,
 * therefore after a `close()` any other call will fail.
 *
 * NOTE: Solaris behaves very different regarding pty semantics.
 * On Solaris a pty is a STREAMS clone where tty semantics get loaded onto the slave end.
 * Other than on BSDs or Linux systems the size and termios settings are lost
 * once the last slave was closed. Therefore those settings are stored
 * explicitly on Solaris and will be applied automatically to a new slave.
 * Since a slave program can alter these settings it is not safe to rely
 * on the values without keeping the slave end open on Solaris.
 */
export class RawPty implements I.IRawPty {
    private _nativePty: I.NativePty;
    private _size: I.Size;
    private _termios: ICTermios;
    private _is_usable(): void {
        if (this._nativePty.master === -1)
            throw new Error('pty is destroyed');
    }
    private _prepare_slave(fd: number): void {
        if (process.platform === 'sunos') {
            native.load_driver(this._nativePty.slave);
            this._termios.writeTo(this._nativePty.slave);
            native.set_size(this._nativePty.slave, this._size.cols, this._size.rows);
        }
    }
    constructor(options?: I.RawPtyOptions) {
        this._nativePty = openpty(options);
        if (process.platform === 'sunos') {
            this._size = native.get_size(this._nativePty.slave);
            this._termios = new Termios(this._nativePty.slave);
        }
    }
    public get master_fd(): number {
        this._is_usable();
        return this._nativePty.master;
    }
    public get slave_fd(): number {
        this._is_usable();
        return this._nativePty.slave;
    }
    public get slavepath(): string {
        this._is_usable();
        return this._nativePty.slavepath;
    }
    public close(): void {
        this._is_usable();
        if (this._nativePty.master !== -1)
            fs.closeSync(this._nativePty.master);
        if (this._nativePty.slave !== -1)
            try { fs.closeSync(this._nativePty.slave); } catch (e) {}
        this._nativePty.master = -1;
        this._nativePty.slave = -1;
        this._nativePty.slavepath = '';
    }
    public open_slave(): number {
        this._is_usable();
        if (this._nativePty.slave === -1) {
            this._nativePty.slave = fs.openSync(this._nativePty.slavepath,
                native.FD_FLAGS.O_RDWR | native.FD_FLAGS.O_NOCTTY);
            this._prepare_slave(this._nativePty.slave);
        }
        return this._nativePty.slave;
    }
    public close_slave(): void {
        this._is_usable();
        if (this._nativePty.slave !== -1) {
            fs.closeSync(this._nativePty.slave);
        }
        this._nativePty.slave = -1;
    }
    public get_size(): I.Size {
        this._is_usable();
        if (process.platform === 'sunos')
            return this._size;
        return native.get_size(this._nativePty.master);
    }
    public set_size(cols: number, rows: number): I.Size {
        this._is_usable();
        if (cols < 1 || rows < 1)
            throw new Error('cols/rows must be greater 0');
        if (process.platform === 'sunos') {
            let to_close: boolean = (this._nativePty.slave === -1);
            if (to_close)
                this.open_slave();
            let size: I.Size = native.set_size(this._nativePty.slave, cols, rows);
            this._size = {cols: cols, rows: rows};
            if (to_close)
                this.close_slave();
            return size;
        }
        return native.set_size(this._nativePty.master, cols, rows);
    }
    public resize(cols: number, rows: number): void {
        this._is_usable();
        this.set_size(cols, rows);
    }
    public get columns(): number {
        this._is_usable();
        return this.get_size().cols;
    }
    public set columns(cols: number) {
        this._is_usable();
        this.resize(cols, this.get_size().rows);
    }
    public get rows(): number {
        this._is_usable();
        return this.get_size().rows;
    }
    public set rows(rows: number) {
        this._is_usable();
        this.resize(this.get_size().cols, rows);
    }
    public get_termios(): ICTermios {
        this._is_usable();
        // should always work on slave end
        if (this._nativePty.slave !== -1)
            return new Termios(this._nativePty.slave);
        if (process.platform === 'sunos')
            return new Termios(this._termios);
        // fall through to master end (not working on solaris)
        return new Termios(this._nativePty.master);
    }
    public set_termios(termios: ICTermios, action?: number): void {
        this._is_usable();
        // should always work on slave end
        if (this._nativePty.slave !== -1) {
            termios.writeTo(this._nativePty.slave, action);
            return;
        }
        if (process.platform === 'sunos') {
            this.open_slave();
            termios.writeTo(this._nativePty.slave, action);
            this._termios = termios;
            this.close_slave();
            return;
        }
        // fall through to master end (not working on solaris)
        termios.writeTo(this._nativePty.master, action);
    }
}


/**
 * Pty - class with pty IO streams.
 *
 * The class extends `RawPty` with IO stream objects
 * to be used in a JS typical fashion.
 * The master end of the pty is split into separate
 * read and write streams:
 *  - `stdin`   write stream of master (stdin for slave)
 *  - `stdout`  read stream of master (stdout for slave)
 *
 * Upon instantiation only the master streams are created by default.
 * If you need a slave stream set `init_slave` to true or call `init_slave_stream()`.
 * With `auto_close` the master streams and the pty will close automatically
 * once all slave consumers hang up, without the underlying pty can be reused.
 */
export class Pty extends RawPty implements I.IPty {
    private _fds: I.PtyFileDescriptors;
    public stdin: null | Socket;
    public stdout: null | Socket;
    public slave: null | tty.ReadStream;
    constructor(options?: I.PtyOptions) {
        super(options);
        this._fds = {read: -1, write: -1};
        this.init_master_streams((options) ? options.auto_close : false);
        if (options && options.init_slave)
            this.init_slave_stream();
    }
    public init_master_streams(auto_close: boolean = false): void {
        this.close_master_streams();
        this._fds = native.get_io_channels(this.master_fd);
        this.stdin = new Socket({fd: this._fds.write, readable: false, writable: true});
        this.stdin.on('end', (): void => {
            try { fs.closeSync(this._fds.write); } catch (e) {}
        });
        this.stdout = new Socket({fd: this._fds.read, readable: true, writable: false});
        this.stdout.on('end', (): void => {
            if (auto_close)
                this.close();
            try { fs.closeSync(this._fds.read); } catch (e) {}
        });
    }
    public close_master_streams(): void {
        if (this.stdin)
            this.stdin.destroy();
        if (this.stdout)
            this.stdout.destroy();
        this.stdin = null;
        this.stdout = null;
        try { fs.closeSync(this._fds.read); } catch (e) {}
        try { fs.closeSync(this._fds.write); } catch (e) {}
        this._fds.read = -1;
        this._fds.write = -1;
    }
    public init_slave_stream(): void {
        this.close_slave_stream();
        if (this.slave_fd === -1)
            this.open_slave();
        this.slave = new ReadStream(this.slave_fd);
        this.slave.writable = true;
    }
    public close_slave_stream(): void {
        if (this.slave)
            this.slave.destroy();
        this.slave = null;
    }
    public close(): void {
        this.close_slave_stream();
        this.close_master_streams();
        super.close();
    }
}


/**
 * helper class to merge stdin and stdout
 */
export class MasterSocket extends Duplex {
    private _reader: Readable;
    private _writer: Writable;
    constructor(reader: Readable, writer: Writable) {
        let opts: any = {allowHalfOpen: false};
        super(opts);
        this._reader = reader;
        this._writer = writer;
        this._reader.pause();

        this._reader.on('data', (data) => {
            if (!this.push(data)) {
                this._reader.pause();
                // FIXME do we need to unshift the last data package?
                //this._reader.unshift(data);
            }
        });
        this._reader.on('close', () => {
            this.emit('close');
        });
    }
    _read(size: number) {
        this._reader.resume();
    }
    _write(chunk: any, encoding: string, callback: Function) {
        this._writer.write(chunk, encoding, callback);
    }
}


/**
 * spawn - spawn a process behind it's own pty.
 */
export function spawn(
    command: string,
    args?: string[],
    options?: I.PtySpawnOptions): I.IPtyProcess
{
    options = options || {};
    options.auto_close = true;
    let jsPty = new Pty(options);
    options.stdio = [jsPty.slave_fd, jsPty.slave_fd, (options.stderr) ? 'pipe' : jsPty.slave_fd];
    options.detached = true;
    let child: I.IPtyProcess = cp.spawn(HELPER, [command].concat(args || []), options) as I.IPtyProcess;
    child.stdin = jsPty.stdin;
    child.stdout = jsPty.stdout;
    child.pty = jsPty;
    jsPty.close_slave();
    return child;
}

function assign(target: any, ...sources: any[]): any {
  sources.forEach(source => Object.keys(source).forEach(key => target[key] = source[key]));
  return target;
}


const DEFAULT_FILE = 'sh';
const DEFAULT_NAME = 'xterm';

export class UnixTerminal extends EventEmitter implements I.ITerminal {
    private _process: I.IPtyProcess;
    public master: Duplex;
    constructor(file?: string, args?: I.ArgvOrCommandLine, opt?: I.IPtyForkOptions) {
        super();

        args = args || [];
        file = file || DEFAULT_FILE;
        opt = opt || {};
        opt.env = opt.env || process.env;

        const cols = opt.cols || DEFAULT_COLS;
        const rows = opt.rows || DEFAULT_ROWS;
        const uid = opt.uid || -1;
        const gid = opt.gid || -1;
        const env = assign({}, opt.env);

        if (opt.env === process.env) {
            this._sanitizeEnv(env);
        }

        const cwd = opt.cwd || process.cwd();
        const name = opt.name || env.TERM || DEFAULT_NAME;
        env.TERM = name;
        //const parsedEnv = this._parseEnv(env);

        const encoding = (opt.encoding === undefined ? 'utf8' : opt.encoding);

        const onexit = (code: any, signal: any) => {
            this.emit('exit', code, signal);
        };

        //const term = pty.fork(file, args, parsedEnv, cwd, #cols, rows, uid, gid, (encoding === 'utf8'), onexit);
        // FIXME: setup termios and apply encoding, uid+gid not working
        let termios: ICTermios = new Termios(0);
        this._process = spawn(file, args, {env: env, size: {cols: cols, rows: rows}, termios: termios, cwd: cwd});
        this._process.on('exit', onexit);
        this.master = new MasterSocket(this._process.stdout, this._process.stdin);

        if (encoding !== null) {
            this.master.setEncoding(encoding);
            this._process.stdout.setEncoding(encoding);
            //this._process.stdin.setEncoding(encoding);
        }

        this._process.stdout.on('close', () => { this.emit('close'); });
    }
    private _sanitizeEnv(env: NodeJS.ProcessEnv): void {
        // Make sure we didn't start our server from inside tmux.
        delete env['TMUX'];
        delete env['TMUX_PANE'];

        // Make sure we didn't start our server from inside screen.
        // http://web.mit.edu/gnu/doc/html/screen_20.html
        delete env['STY'];
        delete env['WINDOW'];

        // Delete some variables that might confuse our terminal.
        delete env['WINDOWID'];
        delete env['TERMCAP'];
        delete env['COLUMNS'];
        delete env['LINES'];
    }

    get slave(): tty.ReadStream {
        return this._process.pty.slave;
    }

    get process(): string {
        return (this._process as any).spawnargs.slice(1).join(' ');
    }
    get pid(): number {
        return this._process.pid;
    }
    write(data: string): void {
        this._process.stdin.write(data);
    }
    resize(cols: number, rows: number): void {
        this._process.pty.resize(cols, rows);
    }
    destroy(): void {
        this._process.pty.close_master_streams();
        this._process.pty.close_slave_stream();
        this._process.pty.close();
        this._process.kill('SIGHUP');
    }
    kill(signal?: string): void {
        this._process.kill(signal);
    }
    setEncoding(encoding: string): void {
        if ((this._process.stdout as any)._decoder)
            delete (this._process.stdout as any)._decoder;
        if ((this._process.stdin as any)._decoder)
            delete (this._process.stdin as any)._decoder;
        if (encoding) {
            this._process.stdout.setEncoding(encoding);
            //this._process.stdin.setEncoding(encoding);
        }
    }
    resume(): void {
        this._process.stdout.resume();
        //this._process.stdin.resume();
    }
    pause(): void {
        this._process.stdout.pause();
        //this._process.stdin.pause();
    }
    addListener(eventName: string, listener: (...args: any[]) => any): this {
        this.on(eventName, listener);
        return this;
    }
    public emit(eventName: string, ...args: any[]): any {
        return this.master.emit.apply(this.master, arguments);
    }
    on(eventName: string, listener: (...args: any[]) => any): this {
        this.master.on(eventName, listener);
        //try { this._process.stdout.on(eventName, listener); } catch (e) {}
        //try { this._process.stdin.on(eventName, listener); } catch (e) {}
        return this;
    }
    listeners(eventName: string): Function[] {
        return this.master.listeners(eventName);
    }
    removeListener(eventName: string, listener: (...args: any[]) => any): this {
        this.master.removeListener(eventName, listener);
        try { this._process.stdout.removeListener(eventName, listener); } catch (e) {}
        try { this._process.stdin.removeListener(eventName, listener); } catch (e) {}
        return this;
    }
    removeAllListeners(eventName: string): this {
        this.master.removeAllListeners(eventName);
        try { this._process.stdout.removeAllListeners(eventName); } catch (e) {}
        try { this._process.stdin.removeAllListeners(eventName); } catch (e) {}
        return this;
    }
    once(eventName: string, listener: (...args: any[]) => any): this {
        this.master.once(eventName, listener);
        try { this._process.stdout.once(eventName, listener); } catch (e) {}
        try { this._process.stdin.once(eventName, listener); } catch (e) {}
        return this;
    }
}