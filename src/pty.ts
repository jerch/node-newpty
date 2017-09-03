import * as I from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import {Socket} from 'net';
import {ITermios, Termios, native as termiosNative} from 'node-termios';
import {EventEmitter} from 'events';
import * as cp from 'child_process';
import * as tty from 'tty';

// cant import ReadStream?
const ReadStream = require('tty').ReadStream;
const s = termiosNative.ALL_SYMBOLS;

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
    private _termios: ITermios;
    private _is_usable(): void {
        if (this._nativePty.master === -1)
            throw new Error('pty is destroyed');
    }
    private _prepare_slave(fd: number): void {
        this._is_usable();
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
            let no_slave: boolean = (this._nativePty.slave === -1);
            if (no_slave)
                this.open_slave();
            let size: I.Size = native.set_size(this._nativePty.slave, cols, rows);
            this._size = {cols: cols, rows: rows};
            if (no_slave)
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
    public get_termios(): ITermios {
        this._is_usable();
        // should always work on slave end
        if (this._nativePty.slave !== -1)
            return new Termios(this._nativePty.slave);
        if (process.platform === 'sunos')
            return new Termios(this._termios);
        // fall through to master end (not working on solaris)
        return new Termios(this._nativePty.master);
    }
    public set_termios(termios: ITermios, action?: number): void {
        this._is_usable();
        // should always work on slave end
        if (this._nativePty.slave !== -1) {
            termios.writeTo(this._nativePty.slave, action);
            return;
        }
        if (process.platform === 'sunos') {
            let no_slave: boolean = (this._nativePty.slave === -1);
            if (no_slave)
                this.open_slave();
            termios.writeTo(this._nativePty.slave, action);
            this._termios = termios;
            if (no_slave)
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
 * spawn - spawn a process behind it's own pty.
 *
 * spawn creates a new `Pty` and launches the child process with
 * `child_process.spawn` by a small helper binary,
 * that sets the controlling terminal to the slave end of the pty device.
 *
 * `options` supports additional optional parameters:
 *  - termios   termios settings of the pty, if empty all termios flags are zeroed
 *  - size      size settings of the pty, default `{cols: 80, rows: 24}`
 *  - stderr    creates a separate pipe for stderr, default is false
 *
 *  `options.detached` is always set to `true` to get a new process group
 *  with the new process as session leader.
 *  `options.stdio` defaults to the slave pty end for all IO streams.
 *  With `options.stderr` set to `true` an additional pipe for stderr will be set.
 *  NOTE: Use the stderr feature with caution, it might confuse child processes
 *  (e.g. bash will switch to buffered pipe mode and omit escape sequences
 *  while zsh works as expected).
 */
export function spawn(command: string, args?: string[], options?: I.PtySpawnOptions): I.IPtyProcess {
    // prepare options for Pty
    options = options || {};
    options.auto_close = true;

    // create a new pty
    let jsPty = new Pty(options);

    // prepare options for child_process.spawn
    options.stdio = [jsPty.slave_fd, jsPty.slave_fd, (options.stderr) ? 'pipe' : jsPty.slave_fd];
    options.detached = true;

    // launch child process
    let child: I.IPtyProcess = cp.spawn(HELPER, [command].concat(args || []), options) as I.IPtyProcess;

    // append IO streams and the pty
    child.stdin = jsPty.stdin;
    child.stdout = jsPty.stdout;
    child.pty = jsPty;

    // finally close slave end in this process - TODO: should this stay open?
    jsPty.close_slave();

    return child;
}


/**
 * Implementation of the current node-pty API
 */

function assign(target: any, ...sources: any[]): any {
  sources.forEach(source => Object.keys(source).forEach(key => target[key] = source[key]));
  return target;
}

const DEFAULT_FILE = 'sh';
const DEFAULT_NAME = 'xterm';

export class UnixTerminal implements I.ITerminal {
    private _process: I.IPtyProcess;
    private _emitter: EventEmitter;
    private _process_events: string[] = ['close', 'exit', 'disconnect', 'message'];
    private _stdout_events: string[] = ['data', 'readable', 'end'];
    private _stdin_events: string[] = ['drain', 'finish', 'pipe', 'unpipe'];
    private _error_handler: (error: Error) => void;
    public master: null;
    public slave: null;
    private static _sanitizeEnv(env: NodeJS.ProcessEnv): void {
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
    private static _getTermios(encoding: string): ITermios {
        // termios settings taken from node-pty's pty.cc
        let termios: ITermios = new Termios();
        termios.c_iflag = s.ICRNL | s.IXON | s.IXANY | s.IMAXBEL | s.BRKINT;
        if (encoding === 'utf8' && s.IUTF8)
            termios.c_iflag |= s.IUTF8;
        termios.c_oflag = s.OPOST | s.ONLCR;
        termios.c_cflag = s.CREAD | s.CS8 | s.HUPCL;
        termios.c_lflag = s.ICANON | s.ISIG | s.IEXTEN | s.ECHO | s.ECHOE | s.ECHOK | s.ECHOKE | s.ECHOCTL;
        termios.c_cc[s.VEOF] = 4;
        termios.c_cc[s.VEOL] = -1;
        termios.c_cc[s.VEOL2] = -1;
        termios.c_cc[s.VERASE] = 0x7f;
        termios.c_cc[s.VWERASE] = 23;
        termios.c_cc[s.VKILL] = 21;
        termios.c_cc[s.VREPRINT] = 18;
        termios.c_cc[s.VINTR] = 3;
        termios.c_cc[s.VQUIT] = 0x1c;
        termios.c_cc[s.VSUSP] = 26;
        termios.c_cc[s.VSTART] = 17;
        termios.c_cc[s.VSTOP] = 19;
        termios.c_cc[s.VLNEXT] = 22;
        termios.c_cc[s.VDISCARD] = 15;
        termios.c_cc[s.VMIN] = 1;
        termios.c_cc[s.VTIME] = 0;
        if (process.platform === 'darwin') {
            termios.c_cc[s.VDSUSP] = 25;
            termios.c_cc[s.VSTATUS] = 20;
        }
        termios.setSpeed(s.B38400);
        return termios;
    }
    constructor(file?: string, args?: I.ArgvOrCommandLine, opt?: I.IPtyForkOptions) {
        this._emitter = new EventEmitter();
        this._error_handler = (err) => { this._emitter.emit('error', err); };

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
            UnixTerminal._sanitizeEnv(env);
        }

        const cwd = opt.cwd || process.cwd();
        env.TERM = opt.name || env.TERM || DEFAULT_NAME;
        const encoding = (opt.encoding === undefined ? 'utf8' : opt.encoding);

        // prepare spawn options
        let options: I.PtySpawnOptions = {};
        options.env = env;
        options.size = {cols: cols, rows: rows};
        options.termios = UnixTerminal._getTermios(encoding);
        options.cwd = cwd;
        if (gid !== -1 && uid !== -1) {
            options.gid = gid;
            options.uid = uid;
        }

        // spawn pty + process
        this._process = spawn(file, args, options);

        if (encoding !== null)
            this._process.stdout.setEncoding(encoding);
    }
    public get process(): string {
        return (this._process as any).spawnargs.slice(1).join(' ');
    }
    public get pid(): number {
        return this._process.pid;
    }
    public write(data: string): void {
        this._process.stdin.write(data);
    }
    public read(size?: number): any {
        return this._process.stdout.read(size);
    }
    public resize(cols: number, rows: number): void {
        this._process.pty.resize(cols, rows);
    }
    public destroy(): void {
        this._process.pty.close_master_streams();
        this._process.pty.close_slave_stream();
        this._process.pty.close();
        this._process.kill('SIGHUP');
    }
    public kill(signal?: string): void {
        this._process.kill(signal);
    }
    public setEncoding(encoding: string): void {
        if ((this._process.stdout as any)._decoder)
            delete (this._process.stdout as any)._decoder;
        if (encoding) {
            this._process.stdout.setEncoding(encoding);
        }
    }
    public end(data: string, encoding?: string): void{
        this._process.stdin.end(data, encoding);
    }
    public pipe(dest: any, options: any): any {
        return this._process.stdout.pipe(dest, options);
    }
    public resume(): void {
        this._process.stdout.resume();
    }
    public pause(): void {
        this._process.stdout.pause();
    }
    public addListener(eventName: string, listener: (...args: any[]) => any): this {
        this.on(eventName, listener);
        return this;
    }
    private _routeEvent(eventName: string): EventEmitter {
        if (this._process_events.indexOf(eventName) !== -1)
            return this._process;
        if (this._stdout_events.indexOf(eventName) !== -1)
            return this._process.stdout;
        if (this._stdin_events.indexOf(eventName) !== -1)
            return this._process.stdin;
        return this._emitter;
    }
    public on(eventName: string, listener: (...args: any[]) => any): this {
        if (eventName === 'error' && !this._emitter.listeners('error').length) {
            this._process.on('error', this._error_handler);
            this._process.stdout.on('error', this._error_handler);
            this._process.stdout.on('error', this._error_handler);
        }
        let emitter: EventEmitter = this._routeEvent(eventName);
        emitter.on.apply(emitter, arguments);
        return this;
    }
    public listeners(eventName: string): Function[] {
        return this._routeEvent(eventName).listeners(eventName);
    }
    public removeListener(eventName: string, listener: (...args: any[]) => any): this {
        let emitter: EventEmitter = this._routeEvent(eventName);
        emitter.removeListener.apply(emitter, arguments);
        if (eventName === 'error' && !this._emitter.listeners('error').length) {
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
        }
        return this;
    }
    // FIXME: do not remove 'end' from Pty.init_master_streams
    public removeAllListeners(eventName: string): this {
        this._routeEvent(eventName).removeAllListeners(eventName);
        if (eventName === 'error') {
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
            this._process.removeListener('error', this._error_handler);
        }
        return this;
    }
    public once(eventName: string, listener: (...args: any[]) => any): this {
        let emitter: EventEmitter = this._routeEvent(eventName);
        emitter.once.apply(emitter, arguments);
        if (eventName === 'error') {
            this._process.once('error', this._error_handler);
            this._process.stdout.once('error', this._error_handler);
            this._process.stdout.once('error', this._error_handler);
        }
        return this;
    }
}
