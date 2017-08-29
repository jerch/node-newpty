var pty = require('./lib/pty');

var child = pty.spawn2('bash', ['-l'], {});

child.stdout.on('data', function(data) {
    console.log(data.toString());
});
child.stdout.on('end', function() {
    console.log('pty ended.');
});

setTimeout(function(){ child.stdin.write('ls\r'); }, 1000);
setTimeout(function(){ child.stdin.write('exit\r'); }, 1000);
