if (process.platform === 'win32')
    process.exit();

// FIXME: tests aborted under NetBSD  -- assertion "loop->watchers[w->fd] == w" failed

import * as assert from 'assert';
import * as fs from 'fs';
import * as pty from './pty';
import * as Interfaces from './interfaces';
import {Termios, ITermios} from 'node-termios';

describe('native functions', () => {
    it('ptname/grantpt/unlockpt + open slave', () => {
        let master: number = -1;
        assert.doesNotThrow(() => {
            master = pty.native.openpt(pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
            pty.native.grantpt(master);
            pty.native.unlockpt(master);
        });
        assert.equal(true, master > 0);
        let slavepath: string = '';
        assert.doesNotThrow(() => {
            slavepath = pty.native.ptsname(master);
        });
        assert.notEqual('', slavepath);
        let slave: number = -1;
        assert.doesNotThrow(() => {
            slave = fs.openSync(slavepath, pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
        });
        assert.notEqual(-1, slave);
        fs.closeSync(master);
        fs.closeSync(slave);
    });
    it('apply termios settings (slave only)', () => {
        // TODO
    });
    it('set_size', () => {
        let master: number = -1;
        let slave: number = -1;
        assert.doesNotThrow(() => {
            master = pty.native.openpt(pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
            pty.native.grantpt(master);
            pty.native.unlockpt(master);
            // slave must be opened to set size under BSDs
            slave = fs.openSync(pty.native.ptsname(master), pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
            // solaris needs this, empty call for others
            pty.native.load_driver(slave);
        });
        let size: Interfaces.Size = {cols: -1, rows: -1};
        assert.doesNotThrow(() => {
            size = pty.native.set_size(master, 12, 13);
        });
        assert.equal(size.cols, 12);
        assert.equal(size.rows, 13);
        size = {cols: -1, rows: -1};
        assert.doesNotThrow(() => {
            size = pty.native.get_size(master);
        });
        assert.equal(size.cols, 12);
        assert.equal(size.rows, 13);
        if (process.platform !== 'sunos') {
            size = {cols: -1, rows: -1};
            assert.doesNotThrow(() => {
                size = pty.native.set_size(slave, 23, 24);
            });
            assert.equal(size.cols, 23);
            assert.equal(size.rows, 24);
            assert.doesNotThrow(() => {
                size = pty.native.get_size(slave);
            });
            assert.equal(size.cols, 23);
            assert.equal(size.rows, 24);
        }
        fs.closeSync(master);
        fs.closeSync(slave);
    });
    it('get_size', () => {
        let master: number = -1;
        let slave: number = -1;
        assert.doesNotThrow(() => {
            master = pty.native.openpt(pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
            pty.native.grantpt(master);
            pty.native.unlockpt(master);
            // slave must be opened to set size under BSDs
            slave = fs.openSync(pty.native.ptsname(master), pty.native.FD_FLAGS.O_RDWR | pty.native.FD_FLAGS.O_NOCTTY);
            // solaris needs this, empty call for others
            pty.native.load_driver(slave);
            pty.native.set_size(master, 12, 13);
        });
        let size_master: Interfaces.Size = {cols: -1, rows: -1};
        let size_slave: Interfaces.Size = {cols: -1, rows: -1};
        let size: Interfaces.Size = {cols: 12, rows: 13};
        assert.doesNotThrow(() => {
            size_master = pty.native.get_size(master);
        });
        assert.deepEqual(size_master, size);
        if (process.platform !== 'sunos') {
            assert.doesNotThrow(() => {
                size_slave = pty.native.get_size(slave);
            });
            assert.deepEqual(size_slave, size);
        }
        fs.closeSync(master);
        fs.closeSync(slave);
    });
});
describe('class RawPty', () => {
    it('primitive getter', () => {
        let rawPty: pty.RawPty = new pty.RawPty();
        assert.notEqual(rawPty.master_fd, -1);
        assert.notEqual(rawPty.slave_fd, -1);
        assert.notEqual(rawPty.slavepath, '');
        rawPty.close();
    });
    it('close', () => {
        // disable any access after a close
        let rawPty: pty.RawPty = new pty.RawPty();
        rawPty.close();
        let attributes: string[] = Object.getOwnPropertyNames(Object.getPrototypeOf(rawPty));
        for (let i = 0; i < attributes.length; ++i) {
            if (attributes[i] === 'constructor')
                continue;
            if (attributes[i] === '_is_usable')
                continue;
            assert.throws(() => {
                let a: any = rawPty[attributes[i]];
                if (typeof a === 'function')
                    a();
            });
        }
    });
    it('open/close slave', () => {
        let rawPty: pty.RawPty = new pty.RawPty();
        // after open a slave should be available
        assert.notEqual(rawPty.open_slave(), -1);
        // consecutive open calls should not open different fds
        assert.equal(rawPty.open_slave(), rawPty.open_slave());
        rawPty.close_slave();
        // no slave open
        assert.equal(rawPty.slave_fd, -1);
        // new slave opened
        assert.notEqual(rawPty.open_slave(), -1);
        rawPty.close();
    });
    it('get_size, cols/rows getter', () => {
        let rawPty: pty.RawPty = new pty.RawPty();
        let size1: Interfaces.Size = rawPty.get_size();
        assert.deepEqual(size1, {cols: pty.DEFAULT_COLS, rows: pty.DEFAULT_ROWS});
        rawPty.close();
        rawPty = new pty.RawPty({size: {cols: 50, rows: 100}});
        size1 = rawPty.get_size();
        assert.deepEqual(size1, {cols: 50, rows: 100});
        // size should not interfere with slave state
        rawPty.close_slave();
        let size2: Interfaces.Size = rawPty.get_size();
        assert.deepEqual(size1, size2);
        assert.equal(rawPty.columns, size1.cols);
        assert.equal(rawPty.rows, size1.rows);
        rawPty.close();
    });
    it('set_size, resize, cols/rows getter and setter', () => {
        let rawPty: pty.RawPty = new pty.RawPty();
        let size1: Interfaces.Size = rawPty.set_size(100, 200);
        assert.deepEqual(size1, {cols: 100, rows: 200});
        // size should not interfere with slave state
        rawPty.close_slave();
        // set --> get should be equal
        let size2: Interfaces.Size = rawPty.set_size(200, 400);
        assert.deepEqual(size2, {cols: 200, rows: 400});
        assert.deepEqual(size2, rawPty.get_size());
        // resize --> get should be equal
        rawPty.resize(400, 200);
        assert.deepEqual({cols: 400, rows: 200}, rawPty.get_size());
        // getter
        assert.equal(rawPty.columns, 400);
        assert.equal(rawPty.rows, 200);
        // setter
        rawPty.columns = 800;
        rawPty.rows = 400;
        assert.deepEqual(rawPty.get_size(), {cols: 800, rows: 400});
        // do not allow insane values
        assert.throws(() => { rawPty.resize(-1, 50); });
        assert.throws(() => { rawPty.resize(50, -1); });
        assert.throws(() => { rawPty.resize(0, 50); });
        assert.throws(() => { rawPty.resize(50, 0); });
        rawPty.close();
    });
    it('get/set termios', () => {
        // load termios from stdin
        let rawPty: pty.RawPty = new pty.RawPty({termios: new Termios(0)});
        let termios: ITermios = rawPty.get_termios();
        assert.deepEqual(termios, new Termios(0));
        // termios should not interfere with slave state (reopens slave on solaris)
        rawPty.close_slave();
        assert.deepEqual(termios, rawPty.get_termios());
        // set termios
        termios.c_iflag = 0;
        rawPty.set_termios(termios);
        assert.deepEqual(termios, rawPty.get_termios());
        assert.notDeepEqual(termios, new Termios(0));
        // termios should not interfere with slave state
        rawPty.open_slave();
        termios.c_oflag = 0;
        rawPty.set_termios(termios);
        assert.deepEqual(termios, rawPty.get_termios());
        assert.notDeepEqual(termios, new Termios(0));
        rawPty.close();
    });
});
describe('class Pty', () => {
    it('slave_fd --> stdout', (done) => {
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0)});
        fs.writeSync(jsPty.slave_fd, 'Hello world!\n');
        jsPty.stdout.on('readable', () => {
            assert.equal(jsPty.stdout.read().toString(), 'Hello world!\r\n');
            jsPty.close();
            done();
        });
    });
    it('stdin --> slave_fd', () => {
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0)});
        jsPty.stdin.write('Hello world!\n');
        let buffer: Buffer = new Buffer(100);
        let size: number = fs.readSync(jsPty.slave_fd, buffer, 0, 100, -1);
        assert.deepEqual(buffer.slice(0, size).toString(), 'Hello world!\n');
        jsPty.close();
    });
    it('slave --> stdout', (done) => {
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0), init_slave: true});
        jsPty.slave.write('Hello world!\n');
        jsPty.stdout.on('readable', () => {
            assert.equal(jsPty.stdout.read().toString(), 'Hello world!\r\n');
            jsPty.close();
            done();
        });
    });
    it('stdin --> slave', (done) => {
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0), init_slave: true});
        jsPty.stdin.write('Hello world!\n');
        jsPty.slave.on('readable', () => {
            assert.equal(jsPty.slave.read().toString(), 'Hello world!\n');
            jsPty.close();
            done();
        });
    });
    it('close_stream should emit "close" and invalidate streams', (done) => {
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0), init_slave: true});
        let wait_end: number = 3;
        let ended = (): void => {
            wait_end--;
            if (!wait_end) {
                assert.equal(jsPty.stdin, null);
                assert.equal(jsPty.stdout, null);
                assert.equal(jsPty.slave, null);
                jsPty.close();
                done();
            }
        };
        jsPty.stdin.on('close', () => {
            ended();
        });
        jsPty.stdout.on('close', () => {
            ended();
        });
        jsPty.slave.on('close', () => {
            ended();
        });
        jsPty.close_slave_stream();
        jsPty.close_master_streams();
    });
    it('recreate streams', (done) => {  // FIXME: close_slave_stream() needs rework after NetBSD fix
        let jsPty: pty.Pty = new pty.Pty({termios: new Termios(0), init_slave: true});
        jsPty.close_slave_stream();
        jsPty.close_master_streams();
        jsPty.init_master_streams();
        jsPty.init_slave_stream();
        fs.writeSync(jsPty.master_fd, '');
        jsPty.set_termios(new Termios(0));
        let wait_end: number = 2;
        let ended = (): void => {
            wait_end--;
            if (!wait_end) {
                jsPty.close();
                done();
            }
        };
        jsPty.slave.write('slave --> stdout\n');
        jsPty.stdin.write('stdin --> slave\n');
        jsPty.slave.on('readable', () => {
            let data: Buffer = jsPty.slave.read();
            if (data) {
                assert.equal(data.toString(), 'stdin --> slave\n');
                ended()
            }
        });
        let buffer: string = '';
        jsPty.stdout.on('readable', () => {
            let data: Buffer = jsPty.slave.read();
            if (data)
                buffer += jsPty.stdout.read().toString();
        });
        setTimeout(() => {
            assert.equal(buffer, 'slave --> stdout\r\nstdin --> slave\r\n');
            ended();
        }, 1000);
    });
});
describe('spawn', () => {
    it('stderr redirection of child', (done) => {
        let child: Interfaces.IPtyProcess = pty.spawn(pty.STDERR_TESTER, [],
            {env: process.env, termios: new Termios(0), stderr: true});
        let stdout_buf: string = '';
        let stderr_buf: string = '';
        child.stdout.on('data', (data) => {
            stdout_buf += data.toString();
        });
        child.stderr.on('data', (data) => {
            stderr_buf += data.toString();
        });
        child.stdout.on('close', () => {
            assert.equal(stdout_buf, 'Hello stdout.');
            assert.equal(stderr_buf, 'Hello stderr.');
            done();
        });
    });
    it('stderr redirection of grandchild', (done) => {
        let child: Interfaces.IPtyProcess = pty.spawn('bash', ['-l'],
            {env: process.env, termios: new Termios(0), stderr: true});
        let stderr_buf: string = '';
        // we must consume stdout data to avoid blocking...
        child.stdout.on('data', (data) => {});
        child.stderr.on('data', (data) => {
            stderr_buf += data.toString();
        });
        child.stdout.on('close', () => {
            assert.equal(stderr_buf, 'Hello stderr.');
            done();
        });
        setTimeout(() => { child.stdin.write(pty.STDERR_TESTER + '\r'); }, 200);
        setTimeout(() => { child.stdin.write('exit\r'); }, 500);
    });
    it('stderr redirection of great-grandchild', (done) => {
        let child: Interfaces.IPtyProcess = pty.spawn('bash', ['-l'],
            {env: process.env, termios: new Termios(0), stderr: true});
        let stderr_buf: string = '';
        // we must consume stdout data to avoid blocking...
        child.stdout.on('data', (data) => {});
        child.stderr.on('data', (data) => {
            stderr_buf += data.toString();
        });
        child.stdout.on('close', () => {
            assert.equal(stderr_buf, 'Hello stderr.');
            done();
        });
        setTimeout(() => { child.stdin.write('bash -c ' + pty.STDERR_TESTER + '\r'); }, 200);
        setTimeout(() => { child.stdin.write('exit\r'); }, 500);
    });
});

import { UnixTerminal } from './pty';
import pollUntil = require('pollUntil');
import * as path from 'path';
const FIXTURES_PATH = path.normalize(path.join(__dirname, '..', 'fixtures', 'utf8-character.txt'));

// copied from node-pty's unixTerminal.test.ts
describe('UnixTerminal', () => {
    describe('Constructor', () => {
        it('should set a valid pts name', () => {
            const term = new UnixTerminal('bash', [], {});
            const ttyname: string = (term as any)._process.pty.slavepath;
            let regExp;
            if (process.platform === 'linux') {
                // https://linux.die.net/man/4/pts
                regExp = /^\/dev\/pts\/\d+$/;
            }
            if (process.platform === 'darwin') {
                // https://developer.apple.com/legacy/library/documentation/Darwin/Reference/ManPages/man4/pty.4.html
                regExp = /^\/dev\/tty[p-sP-S][a-z0-9]+$/;
            }
            if (regExp) {
                assert.ok(regExp.test(ttyname), '"' + ttyname + '" should match ' + regExp.toString());
            }
        });
    });

    describe('PtyForkEncodingOption', () => {
        it('should default to utf8', (done) => {
            const term = new UnixTerminal('bash', [ '-c', `cat "${FIXTURES_PATH}"` ]);
            term.on('data', (data) => {
                assert.equal(typeof data, 'string');
                assert.equal(data, '\u00E6');
                done();
            });
        });
        it('should return a Buffer when encoding is null', (done) => {
            const term = new UnixTerminal('bash', [ '-c', `cat "${FIXTURES_PATH}"` ], {
                encoding: null,
            });
            term.on('data', (data) => {
                assert.equal(typeof data, 'object');
                assert.ok(data instanceof Buffer);
                assert.equal(0xC3, data[0]);
                assert.equal(0xA6, data[1]);
                done();
            });
        });
        it('should support other encodings', (done) => {
            const text = 'test æ!';
            const term = new UnixTerminal(null, ['-c', 'echo "' + text + '"'], {
                encoding: 'base64'
            });
            let buffer = '';
            term.on('data', (data) => {
                assert.equal(typeof data, 'string');
                buffer += data;
            });
            (term as any)._process.stdout.on('close', () => {
            //term.on('exit', () => {
                assert.equal(new Buffer(buffer, 'base64').toString().replace('\r', '').replace('\n', ''), text);
                done();
            });
        });
    });
/*
    describe('open', () => {
        let term: UnixTerminal;

        afterEach(() => {
            if (term) {
                term.slave.destroy();
                term.master.destroy();
            }
        });

        it('should open a pty with access to a master and slave socket', (done) => {
            let doneCalled = false;
            term = UnixTerminal.open({});

            let slavebuf = '';
            term.slave.on('data', (data) => {
                slavebuf += data;
            });

            let masterbuf = '';
            term.master.on('data', (data) => {
                masterbuf += data;
            });

            (<any>pollUntil)(() => {
                if (masterbuf === 'slave\r\nmaster\r\n' && slavebuf === 'master\n') {
                    done();
                    return true;
                }
                return false;
            }, [], 200, 10);

            term.slave.write('slave\n');
            term.master.write('master\n');
        });
    });
*/
    describe('check for full output', function() {
        it('test sentinel x50', function(done) {
            this.timeout(5000);
            // must run multiple times since it gets not truncated always
            let runner = function(_done) {
                // some lengthy output call to enforce multiple pipe reads (pipe length is 2^16 in linux)
                const term = new pty.UnixTerminal('bash', ['-c', 'dd if=/dev/zero bs=10000 count=10 && echo -n "__sentinel__"'], {});
                //const term = new pty.UnixTerminal('bash', ['-c', 'ls -lR /usr/lib && echo -n "__sentinel__"'], {});
                let buffer = '';
                term.on('data', (data) => {
                    buffer += data;
                });
                term.on('error', (err) => {
                    console.log(err);
                });
                // FIXME: stdout 'close' seems to be the only safe event for empty read buffers
                (term as any)._process.stdout.on('close', () => {
                    assert.equal(buffer.slice(-12), '__sentinel__');
                    _done();
                });
            };
            let runs = 50;
            let finished = 0;
            let _done = function() {
                finished += 1;
                if (finished === runs)
                    done();
            };
            for (let i=0; i<runs; ++i)
                runner(_done);
        });
    });
});
