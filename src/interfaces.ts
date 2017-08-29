import {Socket} from 'net';
import * as childprocess from 'child_process';
import {ICTermios} from 'node-termios';

export interface Size {
    cols?: number;
    rows?: number;
}

export interface OpenPtyOptions {
    termios?: ICTermios;
    size?: Size;
}

export interface NativePty {
    master: number;
    slave: number;
    slavepath: string;
}

export interface PtyFileDescriptors {
    read: number;
    write: number;
}

export interface  PtyChannels {
    stdin: Socket;
    stdout: Socket;
}

export interface SpawnOptions extends childprocess.SpawnOptions {
    termios?: ICTermios;
    size?: Size;
}

export interface ChildProcess extends childprocess.ChildProcess {
    // TODO: add pty semantics to return value
    master?: number;
    slavepath?: string;
}

export interface FdFlags {
    O_RDONLY: number;
    O_WRONLY: number;
    O_RDWR: number;
    O_NOCTTY: number;
    O_NONBLOCK: number;
}

export interface Native {
    openpt(options: number): number;
    grantpt(fd: number): void;
    unlockpt(fd: number): void;
    ptsname(fd: number): string;
    get_size(fd: number): Size;
    set_size(fd: number, cols: number, rows: number): Size;
    get_io_channels(fd: number): PtyFileDescriptors;
    load_driver(fd: number): void;
    FD_FLAGS: FdFlags;
}
