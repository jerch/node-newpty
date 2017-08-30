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
