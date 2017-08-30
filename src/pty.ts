import * as I from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import {Socket} from 'net';
import {Termios, ICTermios} from 'node-termios';
import {EventEmitter} from 'events';
import * as childprocess from 'child_process';

export const native: I.Native = require(path.join('..', 'build', 'Release', 'pty.node'));

export const DEFAULT_COLS: number = 80;
export const DEFAULT_ROWS: number = 24;


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
 * get_io_channels - get stdin/stdout sockets for the pty master fd.
 *
 * This functions spawns additional OS pipes and forwards data
 * from and to the pty master fd. This is needed to circumvent data loss
 * at the end of the last slave process.
 * The pipes get closed automatically by the underlying poll implementation
 * once `EOF` is reached:
 *      - last open pty slave was closed
 *      - pty master was closed
 *
 * @param fd
 * @param close_master
 * @return {{stdout: Socket, stdin: Socket}}
 */
export function get_io_channels(fd: number, close_master: boolean = true): I.PtyChannels {
    let channels: I.PtyFileDescriptors = native.get_io_channels(fd);

    let stdin: Socket = new Socket({fd: channels.write, readable: false, writable: true});
    stdin.on('end', function (): void {
        try {
            fs.closeSync(channels.write);
        } catch (e) {}
    });

    let stdout: Socket = new Socket({fd: channels.read, readable: true, writable: false});
    stdout.on('end', function (): void {
        try {
            if (close_master)
                fs.closeSync(fd);
            fs.closeSync(channels.read);
        } catch (e) {}
    });

    return {stdin: stdin, stdout: stdout};
}


export const HELPER: string = path.join(__dirname, '..', 'build', 'Release', 'helper');
export const STDERR_TESTER: string = path.join(__dirname, '..', 'build', 'Release', 'stderr_tester');

/**
 * spawn2 - child_process based version.
 * @param command
 * @param args
 * @param options
 * @return {ChildProcess}
 */
export function spawn(
    command: string,
    args?: string[],
    options?: I.SpawnOptions): I.ChildProcess
{
    options = options || {};

    // open a new pty
    let n_pty: I.NativePty = openpty({termios: options.termios, size: options.size});

    // prepare child_process:
    // - set IO channels to the slave end
    // - set child as detached to get `setsid`
    // - insert HELPER as command to get slave as controlling terminal
    options.stdio = [n_pty.slave, n_pty.slave, (options.stderr) ? 'pipe' : n_pty.slave];
    options.detached = true;
    let child: I.ChildProcess = childprocess.spawn(HELPER, [command].concat(args || []), options);

    // get IO channels and attach them to the ChildProcess
    let channels: I.PtyChannels = get_io_channels(n_pty.master);
    child.stdin = channels.stdin;
    child.stdout = channels.stdout;

    // append important pty symbols to the ChildProcess - TODO: add termios and size getters/setters
    child.master = n_pty.master;
    child.slavepath = n_pty.slavepath;

    // finally close slave fd
    fs.closeSync(n_pty.slave);
    return child;
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
 */
// FIXME: solaris maintains a slave fd all the time, needs fix in poller!!!!!
export class RawPty {
    private _nativePty: I.NativePty;
    private _shadowSlave: number;
    private _is_usable(): void {
        if (this._nativePty.master === -1)
            throw new Error('pty is destroyed');
    }
    constructor(options?: I.RawPtyOptions) {
        this._nativePty = openpty(options);
        if (process.platform === 'sunos')
            this._shadowSlave = this._nativePty.slave;
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
            if (process.platform !== 'sunos')
                this._nativePty.slave = fs.openSync(this._nativePty.slavepath,
                    native.FD_FLAGS.O_RDWR | native.FD_FLAGS.O_NOCTTY);
            else
                this._nativePty.slave = this._shadowSlave;
        }
        return this._nativePty.slave;
    }
    public close_slave(): void {
        this._is_usable();
        if (this._nativePty.slave !== -1) {
            // slave cannot be closed on solaris
            if (process.platform !== 'sunos')
                fs.closeSync(this._nativePty.slave);
        }
        this._nativePty.slave = -1;
    }
    public get_size(): I.Size {
        this._is_usable();
        return native.get_size(this._nativePty.master);
    }
    public set_size(cols: number, rows: number): I.Size {
        this._is_usable();
        if (cols > 0 && rows > 0)
            return native.set_size(this._nativePty.master, cols, rows);
        throw new Error('cols/rows must be greater 0');
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
        // special case for solaris
        if (process.platform === 'sunos') {
            return new Termios(this._shadowSlave);
        }
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
        // special case for solaris
        if (process.platform === 'sunos') {
            termios.writeTo(this._shadowSlave, action);
            return;
        }
        // fall through to master end (not working on solaris)
        termios.writeTo(this._nativePty.master, action);
    }
}













class UnixTerminal extends EventEmitter implements I.ITerminal {
    constructor() {
        super();
    }
    get process(): string {
        // TODO: to be implemented
        return '';
    }
    get pid(): number {
        // TODO: to be implemented
        return -1;
    }
    get master(): Socket {
        // TODO: should not be exported directly
        return new Socket();
    }
    get slave(): Socket {
        // TODO: should not be open on parent side once a child was launched
        return new Socket();
    }
    write(data: string): void {}
    resize(cols: number, rows: number): void {}
    destroy(): void {}
    kill(signal?: string): void {}
    setEncoding(encoding: string): void {}
    resume(): void {}
    pause(): void {}
    addListener(eventName: string, listener: (...args: any[]) => any): this {
        return this;
    }
    on(eventName: string, listener: (...args: any[]) => any): this {
        return this;
    }
    listeners(eventName: string): Function[] {
        return [];
    }
    removeListener(eventName: string, listener: (...args: any[]) => any): this {
        return this;
    }
    removeAllListeners(eventName: string): this {
        return this;
    }
    once(eventName: string, listener: (...args: any[]) => any): this {
        return this;
    }
}
