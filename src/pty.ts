import {IOpenPtyOptions, INativePty, IForkPtyResult, IWaitSymbols,
    IWaitStatus, ISize, IPtyFileDescriptors, IPtyChannels} from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import ProcessEnv = NodeJS.ProcessEnv;
// FIXME - create type for Termios
import {Termios} from 'node-termios';

const native = require(path.join('..', 'build', 'Release', 'pty.node'));

export const DEFAULT_COLS: number = 80;
export const DEFAULT_ROWS: number = 24;

// interfaces from C++
export let fork: {(): number} = native.fork;
export let execl: {(path: string, ...args: string[]): string} = native.execl;
export let execlp: {(file: string, ...args: string[]): string} = native.execlp;
export let execle = native.execle;  // FIXME: how to type this?
export let execv: {(path: string, argv: string[]): string} = native.execv;
export let execvp: {(file: string, argv: string[]): string} = native.execvp;
export let execve: {(file: string, argv: string[], env: ProcessEnv): string} = native.execve;
export let waitpid: {(pid: number, options: number, callback: (status?: IWaitStatus) => void): void} = native.waitpid;
export let openpt: {(options: number): number} = native.openpt;
export let grantpt: {(fd: number): void} = native.grantpt;
export let unlockpt: {(fd: number): void} = native.unlockpt;
export let ptsname: {(fd: number): string} = native.ptsname;
export let login_tty: {(fd: number): void} = native.login_tty;
export let get_size: {(fd: number): ISize} = native.get_size;
export let set_size: {(fd: number, cols: number, rows: number): ISize} = native.set_size;
export let _get_io_channels: {(fd: number): IPtyFileDescriptors} = native.get_io_channels;
// FIXME: load_driver missing - how to deal with optional functions (solaris only)?
export let WAITSYMBOLS: IWaitSymbols = native.WAITSYMBOLS;

/**
 * openpty - open a new pty device.
 * @param opts
 * @return {{master: number, slave: number, slavepath: string}}
 */
export function openpty(opts: IOpenPtyOptions): INativePty {
    // get a pty master
    let master: number = -1;
    // TODO: Do we need nonblocking here at all?
    if (process.platform === 'freebsd' || process.platform === 'openbsd')
        master = openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    else
        master = openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);

    // grant and unlock
    grantpt(master);
    unlockpt(master);

    // open slave side
    let slavepath: string = ptsname(master);
    let slave: number = fs.openSync(slavepath, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    if (process.platform === 'sunos')
        // solaris has to load extra drivers on the slave fd to get terminal semantics
        native.load_driver(slave);

    // apply termios settings
    (new Termios((opts) ? opts.termios : null)).writeTo(slave);

    // apply size settings
    let cols: number = (opts && opts.size) ? opts.size.cols || DEFAULT_COLS : DEFAULT_COLS;
    let rows: number = (opts && opts.size) ? opts.size.rows || DEFAULT_ROWS : DEFAULT_ROWS;
    set_size(master, cols, rows);

    return {master: master, slave: slave, slavepath: slavepath};
}

/**
 * forkpty - open a pty device and fork the process with the slave as controlling terminal.
 * @param opts
 * @return {{pid: number, fd: number, slavepath: string}}
 */
export function forkpty(opts: IOpenPtyOptions): IForkPtyResult {
    let nativePty: INativePty = openpty(opts);
    let pid: number = fork();
    switch (pid) {
        case -1:  // error
            fs.closeSync(nativePty.master);
            fs.closeSync(nativePty.slave);
            throw new Error('error running forkpty');
        case 0:   // child
            fs.closeSync(nativePty.master);
            login_tty(nativePty.slave);
            return {pid: 0, fd: nativePty.slave, slavepath: nativePty.slavepath};
        default:  // parent
            fs.closeSync(nativePty.slave);
            return {pid: pid, fd: nativePty.master, slavepath: nativePty.slavepath};
    }
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
 * @return {{stdout: Socket, stdin: Socket}}
 */
export function get_io_channels(fd: number): IPtyChannels {
    let channels: IPtyFileDescriptors = _get_io_channels(fd);
    return {
        stdin: new net.Socket({fd: channels.write, readable: false, writable: true}),
        stdout: new net.Socket({fd: channels.read, readable: true, writable: false})
    };
}