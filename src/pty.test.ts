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
            master = pty.openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);
            pty.grantpt(master);
            pty.unlockpt(master);
        });
        assert.equal(true, master > 0);
        let slavepath: string = '';
        assert.doesNotThrow(() => {
            slavepath = pty.ptsname(master);
        });
        assert.notEqual('', slavepath);
        let slave: number = -1;
        assert.doesNotThrow(() => {
            slave = fs.openSync(slavepath, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
        });
        assert.notEqual(-1, slave);
        fs.closeSync(master);
        fs.closeSync(slave);
    });
    it('apply termios settings (slave only)', () => {
        // TODO
    });
    it('set_size (master only)', () => {
        let master: number = -1;
        assert.doesNotThrow(() => {
            master = pty.openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);
            pty.grantpt(master);
            pty.unlockpt(master);
        });
        let size: Interfaces.ISize = {cols: -1, rows: -1};
        assert.doesNotThrow(() => {
            size = pty.set_size(master, 12, 13);
        });
        assert.equal(size.cols, 12);
        assert.equal(size.rows, 13);
        size = {cols: -1, rows: -1};
        assert.doesNotThrow(() => {
            size = pty.get_size(master);
        });
        assert.equal(size.cols, 12);
        assert.equal(size.rows, 13);
        fs.closeSync(master);
    });
    it('get_size (master and slave)', () => {
        let master: number = -1;
        let slave: number = -1;
        assert.doesNotThrow(() => {
            master = pty.openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);
            pty.grantpt(master);
            pty.unlockpt(master);
            slave = fs.openSync(pty.ptsname(master), fs.constants.O_RDWR | fs.constants.O_NOCTTY);
        });
        let size_master: Interfaces.ISize = {cols: -1, rows: -1};
        let size_slave: Interfaces.ISize = {cols: -1, rows: -1};
        assert.doesNotThrow(() => {
            size_master = pty.get_size(master);
        });
        assert.doesNotThrow(() => {
            size_slave = pty.get_size(slave);
        });
        assert.deepEqual(size_master, size_slave);
        fs.closeSync(master);
        fs.closeSync(slave);
    });
});

describe('openpty', () => {
    it('', () => {});
});

describe('forkpty', () => {
    it('', () => {});
});