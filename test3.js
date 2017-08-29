var fs = require('fs');
var childprocess = require('child_process');
var pty = require('./lib/pty');
var Termios = require('node-termios').Termios;

var n_pty = pty.openpty({termios: new Termios(0)});
var child = childprocess.spawn('bash', ['-l'],
    {env: process.env, stdio: [n_pty.slave, n_pty.slave, n_pty.slave], detached: true});

child.on('exit', function(code, signal) {
    console.log(code, signal);
    try {fs.closeSync(n_pty.slave)} catch(e){}
    try {fs.closeSync(n_pty.master)} catch(e){}
});

var channels = pty.get_io_channels(n_pty.master);
channels.stdout.on('data', function (data) {
    console.log(data.toString());
});
channels.stdout.on('end', function() {
    console.log('pty ended.');
});

setTimeout(function(){ channels.stdin.write('ls\r'); }, 1000);
setTimeout(function(){ channels.stdin.write('exit\r'); }, 2000);
