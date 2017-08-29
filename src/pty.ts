import * as I from './interfaces';
import * as fs from 'fs';
import * as path from 'path';
import {Socket} from 'net';
import {Termios} from 'node-termios';
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
export function forkpty(opts?: I.OpenPtyOptions): I.ForkPtyResult {
    let nativePty: I.NativePty = openpty(opts);
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


// TODO: make this compatible with node-pty API
export function spawn(
    path: string,
    argv: string[],
    env: NodeJS.ProcessEnv,
    exit: Function,
    options: I.OpenPtyOptions): I.PtyChannels
{
    let sub: I.ForkPtyResult = forkpty(options);
    if (!sub.pid) {
        let error = native.execve(path, argv, env);
        process.stderr.write(error);
        process.exit(-1);
    }
    native.waitpid(sub.pid, 0, function(status: I.WaitStatus): void {
        let code: number = (status.WIFEXITED) ? status.WEXITSTATUS : null;
        let signal: number = (status.WIFSIGNALED) ? status.WTERMSIG : null;
        exit(code, signal);
    });
    return get_io_channels(sub.fd); // TODO: create terminal/process type
}


/**
 * spawn2 - child_process based version.
 * @param command
 * @param args
 * @param options
 * @return {ChildProcess}
 */
export function spawn2(
    command: string,
    args?: string[],
    options?: I.SpawnOptions): I.ChildProcess
{
    options = options || {};
    let pty_opts: I.OpenPtyOptions = {termios: options.termios, size: options.size};
    let n_pty: I.NativePty = openpty(pty_opts);
    let channels: I.PtyChannels = get_io_channels(n_pty.master);
    options.stdio = [n_pty.slave, n_pty.slave, n_pty.slave];
    options.detached = true;
    let child: I.ChildProcess = childprocess.spawn(command, args, options);
    fs.closeSync(n_pty.slave);
    child.stdin = channels.stdin;
    child.stdout = channels.stdout;
    child.master = n_pty.master;
    child.slavepath = n_pty.slavepath;
    return child;
}
