var pty = require('./lib/pty');
var Termios = require('node-termios').Termios;

var child = pty.spawn(
    '/bin/bash',
    ['/bin/bash', '-l'],
    process.env,
    function(code, signal){console.log('process ended:\n', code, signal);},
    {termios: new Termios(0)}
);

child.stdout.on('data', function(data) {
    console.log(data.toString());
});
child.stdout.on('end', function() {
    console.log('pty ended.');
});

setTimeout(function(){ child.stdin.write('ls\r'); }, 1000);
setTimeout(function(){ child.stdin.write('exit\r'); }, 2000);
