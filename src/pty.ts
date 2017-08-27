import {IOpenPtyOptions, INativePty, IForkPtyResult, IWaitSymbols,
    IWaitStatus, ISize, IPtyChannels} from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
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
export let openpt: {(fd: number): number} = native.openpt;
export let grantpt: {(fd: number): void} = native.grantpt;
export let unlockpt: {(fd: number): void} = native.unlockpt;
export let ptsname: {(fd: number): string} = native.ptsname;
export let login_tty: {(fd: number): void} = native.login_tty;
export let get_size: {(fd: number): ISize} = native.get_size;
export let set_size: {(fd: number, cols: number, rows: number): ISize} = native.set_size;
export let get_io_channels: {(fd: number): IPtyChannels} = native.get_io_channels;
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
