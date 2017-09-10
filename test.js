var pty = require('./lib/pty');
var Termios = require('node-termios').Termios;
var t = new Termios(0);

var child = pty.spawn('bash', ['-l'],
    {env: process.env, termios: t, stderr: true});
delete t;


child.stdout.on('data', function(data) {
    console.log('<stdout>' + data.toString() + '</stdout>');
});
child.stdout.on('close', function() {
    console.log('pty ended.');
});
if (child.stderr)
    child.stderr.on('data', function(data) {
        console.log('<stderr>' + data.toString() + '</stderr>');
    });

//setTimeout(function(){ child.stdin.write('build/Release/stderr_tester\r'); }, 1000);
//setTimeout(function(){ child.stdin.write('ls --foobar\r'); }, 2000);
//setTimeout(function(){ child.stdin.write('exit\r'); }, 3000);
