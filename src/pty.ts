import {IOpenPtyOptions, INativePty, IForkPtyResult, IWaitSymbols,
    IWaitStatus, ISize, IPtyFileDescriptors, IPtyChannels} from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import {Socket} from 'net';
import ProcessEnv = NodeJS.ProcessEnv;
import {Termios, ICTermios} from 'node-termios';
import * as childprocess from 'child_process';

// interface from C++
export interface INative {
    fork(): number;
    execl(path: string, ...args: string[]): string;
    execlp(file: string, ...args: string[]): string;
    execle(...args: any[]): string;
    execv(path: string, argv: string[]): string;
    execvp(file: string, argv: string[]): string;
    execve(file: string, argv: string[], env: ProcessEnv): string;
    waitpid(pid: number, options: number, callback: (status?: IWaitStatus) => void): void;
    openpt(options: number): number;
    grantpt(fd: number): void;
    unlockpt(fd: number): void;
    ptsname(fd: number): string;
    login_tty(fd: number): void;
    get_size(fd: number): ISize;
    set_size(fd: number, cols: number, rows: number): ISize;
    get_io_channels(fd: number): IPtyFileDescriptors;
    load_driver(fd: number): void;
    WAITSYMBOLS: IWaitSymbols;
}
export const native: INative = require(path.join('..', 'build', 'Release', 'pty.node'));

export const DEFAULT_COLS: number = 80;
export const DEFAULT_ROWS: number = 24;

/**
 * openpty - open a new pty device.
 * @param opts
 * @return {{master: number, slave: number, slavepath: string}}
 */
export function openpty(opts?: IOpenPtyOptions): INativePty {
    // get a pty master
    let master = native.openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);

    // grant and unlock
    native.grantpt(master);
    native.unlockpt(master);

    // open slave side
    let slavepath: string = native.ptsname(master);
    let slave: number = fs.openSync(slavepath, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
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
 * forkpty - open a pty device and fork the process with the slave as controlling terminal.
 * @param opts
 * @return {{pid: number, fd: number, slavepath: string}}
 */
export function forkpty(opts?: IOpenPtyOptions): IForkPtyResult {
    let nativePty: INativePty = openpty(opts);
    let pid: number = native.fork();
    switch (pid) {
        case -1:  // error
            fs.closeSync(nativePty.master);
            fs.closeSync(nativePty.slave);
            throw new Error('error running forkpty');
        case 0:   // child
            fs.closeSync(nativePty.master);
            native.login_tty(nativePty.slave);
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
    let channels: IPtyFileDescriptors = native.get_io_channels(fd);

    let stdin: Socket = new Socket({fd: channels.write, readable: false, writable: true});
    stdin.on('end', function () {
        try {fs.closeSync(channels.write);} catch (e){}
    });

    let stdout: Socket = new Socket({fd: channels.read, readable: true, writable: false});
    stdout.on('end', function () {
        try {fs.closeSync(channels.read);} catch (e){}
    });

    return {stdin: stdin, stdout: stdout};
}


export function spawn(
    path: string,
    argv: string[],
    env: ProcessEnv,
    exit: Function,
    options: IOpenPtyOptions): IPtyChannels
{
    let sub: IForkPtyResult = forkpty(options);
    if (!sub.pid) {
        let error = native.execve(path, argv, env);
        process.stderr.write(error);
        process.exit(-1);
    }
    native.waitpid(sub.pid, 0, function(status) {
        exit(status);
    });
    return get_io_channels(sub.fd);
}

export interface SpawnOptions extends childprocess.SpawnOptions {
        termios?: ICTermios;
        size?: ISize;
}

export interface ChildProcess extends childprocess.ChildProcess {
        // TODO: add pty semantics to return value
        master?: number;
        slavepath?: string;
}


export function spawn2(
    command: string,
    args?: string[],
    options?: SpawnOptions): ChildProcess
{
    options = options || {};
    let pty_opts: IOpenPtyOptions = {termios: options.termios, size: options.size};
    let n_pty: INativePty = openpty(pty_opts);
    let channels: IPtyChannels = get_io_channels(n_pty.master);
    options.stdio = [n_pty.slave, n_pty.slave, n_pty.slave];
    options.detached = true;
    let child: ChildProcess = childprocess.spawn(command, args, options);
    fs.closeSync(n_pty.slave);
    child.stdin = channels.stdin;
    child.stdout = channels.stdout;
    child.master = n_pty.master;
    child.slavepath = n_pty.slavepath;
    return child;
}