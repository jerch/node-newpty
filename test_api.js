var os = require('os');
var pty = require('./lib/pty');

var shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

var ptyProcess = new pty.UnixTerminal(shell, ['-l'], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    cwd: process.env.HOME,
    env: process.env
});

ptyProcess.on('data', function(data) {
    console.log(data);
});
ptyProcess.on('close', function() {
    console.log('pty closed');
});
ptyProcess.on('exit', function(code, signal) {
    console.log('exit:', code, signal);
});

ptyProcess.write('ls\r');
setTimeout(function() {
    ptyProcess.resize(100, 40);
    ptyProcess.write('ls\r');
}, 200);
setTimeout(function(){ptyProcess.write('exit\r');}, 500);
