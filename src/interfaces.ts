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

export type RawPtyOptions = OpenPtyOptions;

export interface PtyOptions extends RawPtyOptions {
    /**
     * auto_close raw pty - defaults to false
     * destroys the pty once the slave side hang up
     */
    auto_close?: boolean;

    /**
     * init a slave socket - defaults to false
     * only reasonable for slave processing within this process
     * (dont use with a child process)
     */
    init_slave?: boolean;
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
    // termios settings applied to the new pty device
    termios?: ICTermios;
    // size settings applied to the new pty device
    size?: Size;
    // additional stderr pipe (CAVE: might not work correctly with every child process)
    stderr?: boolean;
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

// old node-pty interface
export interface ITerminal {
    /**
     * Gets the name of the process.
     */
    process: string;

    /**
     * Gets the process ID.
     */
    pid: number;

    /**
     * The socket for the master file descriptor. This is not supported on
     * Windows.
     */
    master: Socket;

    /**
     * The socket for the slave file descriptor. This is not supported on Windows.
     */
    slave: Socket;

    /**
     * Writes data to the socket.
     * @param data The data to write.
     */
    write(data: string): void;

    /**
     * Resize the pty.
     * @param cols The number of columns.
     * @param rows The number of rows.
     */
    resize(cols: number, rows: number): void;

    /**
     * Close, kill and destroy the socket.
     */
    destroy(): void;

    /**
     * Kill the pty.
     * @param signal The signal to send, by default this is SIGHUP. This is not
     * supported on Windows.
     */
    kill(signal?: string): void;

    /**
     * Set the pty socket encoding.
     */
    setEncoding(encoding: string): void;

    /**
     * Resume the pty socket.
     */
    resume(): void;

    /**
     * Pause the pty socket.
     */
    pause(): void;

    /**
     * Alias for ITerminal.on(eventName, listener).
     */
    addListener(eventName: string, listener: (...args: any[]) => any): void;

    /**
     * Adds the listener function to the end of the listeners array for the event
     * named eventName.
     * @param eventName The event name.
     * @param listener The callback function
     */
    on(eventName: string, listener: (...args: any[]) => any): void;

    /**
     * Returns a copy of the array of listeners for the event named eventName.
     */
    listeners(eventName: string): Function[];

    /**
     * Removes the specified listener from the listener array for the event named
     * eventName.
     */
    removeListener(eventName: string, listener: (...args: any[]) => any): void;

    /**
     * Removes all listeners, or those of the specified eventName.
     */
    removeAllListeners(eventName: string): void;

    /**
     * Adds a one time listener function for the event named eventName. The next
     * time eventName is triggered, this listener is removed and then invoked.
     */
    once(eventName: string, listener: (...args: any[]) => any): void;
}
