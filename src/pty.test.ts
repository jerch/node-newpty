if (process.platform === 'win32')
    process.exit();

import * as assert from 'assert';
import * as fs from 'fs';
import * as pty from './pty';
import * as Interfaces from './interfaces';

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