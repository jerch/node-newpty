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

export interface ForkPtyResult {
    pid: number;
    fd: number;
    slavepath: string;
}

export interface WaitSymbols {
    WNOHANG: number;
    WUNTRACED: number;
    WCONTINUED?: number;
    WEXITED?: number;
    WSTOPPED?: number;
    WNOWAIT?: number;
    WTRAPPED?: number;
}

export interface WaitStatus {
    pid: number;
    WIFEXITED: boolean;
    WEXITSTATUS: number;
    WIFSIGNALED: boolean;
    WTERMSIG: number;
    WCOREDUMP?: boolean;  // FIXME: wrong -1 in C++
    WIFSTOPPED: boolean;
    WSTOPSIG: number;
    WIFCONTINUED?: boolean;
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

export interface Native {
    fork(): number;
    execl(path: string, ...args: string[]): string;
    execlp(file: string, ...args: string[]): string;
    execle(...args: any[]): string;
    execv(path: string, argv: string[]): string;
    execvp(file: string, argv: string[]): string;
    execve(file: string, argv: string[], env: NodeJS.ProcessEnv): string;
    waitpid(pid: number, options: number, callback: (status?: WaitStatus) => void): void;
    openpt(options: number): number;
    grantpt(fd: number): void;
    unlockpt(fd: number): void;
    ptsname(fd: number): string;
    login_tty(fd: number): void;
    get_size(fd: number): Size;
    set_size(fd: number, cols: number, rows: number): Size;
    get_io_channels(fd: number): PtyFileDescriptors;
    load_driver(fd: number): void;
    WAITSYMBOLS: WaitSymbols;
}
