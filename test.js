var pty = require('./lib/pty');
var Termios = require('node-termios').Termios;

var child = pty.spawn('bash', ['-l'],
    {env: process.env, termios: new Termios(0), stderr: true});


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

setTimeout(function(){ child.stdin.write('build/Release/stderr_tester\r'); }, 1000);
setTimeout(function(){ child.stdin.write('ls --foobar\r'); }, 2000);
setTimeout(function(){ child.stdin.write('exit\r'); }, 3000);

/*
child.stdout.pipe(process.stdout);
process.stdin.setRawMode(true);
process.stdin.pipe(child.stdin);
*/
