import * as net from 'net';

export interface ISize {
    cols?: number;
    rows?: number;
}

export interface IOpenPtyOptions {
    termios?: any;  // FIXME: build typing for Termios
    size?: ISize;
}

export interface INativePty {
    master: number;
    slave: number;
    slavepath: string;
}

export interface IForkPtyResult {
    pid: number;
    fd: number;
    slavepath: string;
}

export interface IWaitSymbols {
    WNOHANG: number;
    WUNTRACED: number;
    WCONTINUED?: number;
    WEXITED?: number;
    WSTOPPED?: number;
    WNOWAIT?: number;
    WTRAPPED?: number;
}

export interface IWaitStatus {
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

export interface IPtyFileDescriptors {
    read: number;
    write: number;
}

export interface IPtyChannels {
    stdin: net.Socket;
    stdout: net.Socket;
}
