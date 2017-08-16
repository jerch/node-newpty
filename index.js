var pty = require('./build/Release/pty');
var Termios = require('node-termios').Termios;
var fs = require('fs');

var COLS = 80;
var ROWS = 25;

function openpty(opts) {
    // get a pty master
    var master = pty.openpt(fs.constants.O_RDWR | fs.constants.O_NOCTTY);

    // grant and unlock
    pty.grantpt(master);
    pty.unlockpt(master);

    // open slave side
    var slavename = pty.ptsname(master);
    var slave = fs.openSync(slavename, fs.constants.O_RDWR | fs.constants.O_NOCTTY);

    // apply termios settings
    (new Termios((opts) ? opts.termios: null)).writeTo(slave);

    // apply size settings
    var cols = (opts && opts.size) ? opts.size.columns || COLS : COLS;
    var rows = (opts && opts.size) ? opts.size.rows || ROWS : ROWS;
    pty.set_size(master, cols, rows);

    return {master: master, slave: slave, slavename: slavename};
}

function forkpty(opts) {
    var fds = openpty(opts);
    var pid = pty.fork();
    switch (pid) {
        case -1:  // error
            fs.closeSync(fds.master);
            fs.closeSync(fds.slave);
            throw new Error('error running forkpty');
        case 0:   // child
            fs.closeSync(fds.master);
            pty.login_tty(fds.slave);
            return {pid: 0, slave: fds.slave, slavename: fds.slavename};
        default:  // parent
            fs.closeSync(fds.slave);
            return {pid: pid, master: fds.master, slavename: fds.slavename};
    }
}


module.exports = require('./build/Release/pty');
module.exports['openpty'] = openpty;
module.exports['forkpty'] = forkpty;