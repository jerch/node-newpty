if (process.platform === 'win32')
    process.exit();

import * as assert from 'assert';
import * as fs from 'fs';
import * as pty from './pty';
import * as Interfaces from './interfaces';
import {Termios, ICTermios} from 'node-termios';

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
describe('spawn', () => {
    it('stderr redirection of child', (done) => {
        let child: Interfaces.ChildProcess = pty.spawn(pty.STDERR_TESTER, [],
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
        let child: Interfaces.ChildProcess = pty.spawn('bash', ['-l'],
            {env: process.env, termios: new Termios(0), stderr: true});
        let stderr_buf: string = '';
        child.stdout.on('data', (data) => {
            // we must consume stdout data to avoid blocking...
        });
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
        let child: Interfaces.ChildProcess = pty.spawn('bash', ['-l'],
            {env: process.env, termios: new Termios(0), stderr: true});
        let stderr_buf: string = '';
        child.stdout.on('data', (data) => {
            // we must consume stdout data to avoid blocking...
        });
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
describe('RawPty', () => {
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
        let termios: ICTermios = rawPty.get_termios();
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
