import {Socket} from 'net';
import * as cp from 'child_process';
import {ICTermios} from 'node-termios';
import {ReadStream} from 'tty';
import {Duplex} from "stream";


/**
 * File flags exported by the native module.
 */
export interface FdFlags {
    O_RDONLY: number;
    O_WRONLY: number;
    O_RDWR: number;
    O_NOCTTY: number;
    O_NONBLOCK: number;
}


/**
 * terminal size
 */
export interface Size {
    cols?: number;
    rows?: number;
}


/**
 * file descriptor pair for read/write to pty master
 */
export interface PtyFileDescriptors {
    read: number;
    write: number;
}


/**
 * native exports
 */
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


/**
 * low level pty data as returned by openpty
 */
export interface NativePty {
    master: number;
    slave: number;
    slavepath: string;
}


/**
 * master IO streams FIXME: to beremoved
 */
export interface  PtyChannels {
    stdin: Socket;
    stdout: Socket;
}


/**
 * options for openpty and RawPty()
 */
export interface OpenPtyOptions {
    termios?: ICTermios;
    size?: Size;
}
export type RawPtyOptions = OpenPtyOptions;


/**
 * options for Pty()
 */
export interface PtyOptions extends RawPtyOptions {
    /**
     * auto_close raw pty - defaults to false
     * destroys the pty once the slave side hangs up
     */
    auto_close?: boolean;

    /**
     * init a slave socket - defaults to false
     * only reasonable for slave processing within this process
     * (dont use with a child process)
     */
    init_slave?: boolean;
}


/**
 * RawPty interface
 */
export interface IRawPty {
    /**
     * getter of the master file descriptor
     */
    master_fd: number;

    /**
     * getter of the slave file descriptor. -1 if not opened
     */
    slave_fd: number;

    /**
     * getter of the slave pathname
     */
    slavepath: string;

    /**
     * close pty, any further usage will fail
     */
    close(): void;

    /**
     * open the slave side of the pty if not opened
     */
    open_slave(): number;

    /**
     * close slave side of the pty FIXME: Does not close on Solaris atm.
     */
    close_slave(): void;

    /**
     * get the size settings of the pty
     */
    get_size(): Size;

    /**
     * set the of the pty and return new size settings
     */
    set_size(cols: number, rows: number): Size;

    /**
     * set the of the pty
     */
    resize(cols: number, rows: number): void;

    /**
     * get and set the columns of the pty
     */
    columns: number;

    /**
     * get and set the rows of the pty
     */
    rows: number;

    /**
     * get the termios settings of the pty
     */
    get_termios(): ICTermios;

    /**
     * set the termios settings of the pty
     * @param termios
     * @param action
     */
    set_termios(termios: ICTermios, action?: number): void;
}


/**
 * Pty interface
 */
export interface IPty extends IRawPty {
    /**
     * write socket of the pty master
     */
    stdin: null | Socket;

    /**
     * read socket of the pty master
     */
    stdout: null | Socket;

    /**
     * read/write socket of the pty slave
     */
    slave: null | ReadStream;

    /**
     * initialize master streams (stdin, stdout), closes previous streams
     * @param auto_close
     */
    init_master_streams(auto_close: boolean): void;

    /**
     * close master streams (stdin, stdout)
     */
    close_master_streams(): void;

    /**
     * initialize slave stream
     */
    init_slave_stream(): void;

    /**
     * close slave stream
     */
    close_slave_stream(): void;
}


/**
 * modified ChildProcess interface to hold a reference to Pty
 */
export interface IPtyProcess extends cp.ChildProcess {
    pty: IPty;
}

/**
 * modified SpawnOptions
 */
export interface PtySpawnOptions extends cp.SpawnOptions {
    /**
     * termios settings applied to the pty device
     */
    termios?: ICTermios;

    /**
     * size settings applied to the new pty device
     */
    size?: Size;

    /**
     * additional stderr pipe
     * CAVE: might not work correctly with every child process
     */
    stderr?: boolean;

    /**
     * auto_close pty on exit
     */
    auto_close?: boolean;
}


/**
 * Old node-pty interfaces.
 * Implemented for backwards compatibility.
 */
export type ArgvOrCommandLine = string[];

export interface IPtyForkOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  encoding?: string;
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
    master: Duplex;

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
