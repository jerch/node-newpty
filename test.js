var own_module = require('./lib/pty');
var Termios = require('node-termios').Termios;
var net = require('net');

var pid = own_module.forkpty({termios: new Termios(0)});
if (pid.pid){
    // parent

    // get STDIN/STDOUT file descriptors suitable for net.Socket
    var channels = own_module.get_io_channels(pid.fd);
    var stdout = net.Socket({fd: channels.read, readable: true, writable: false});
    var stdin = net.Socket({fd: channels.write, readable: false, writable: true});

    stdout.on('data', function(data) {
        console.log(data.toString());
    });

    stdout.on('end', function() {
        console.log('pty stream end');
    });

    // indicates process exit with options 0
    own_module.waitpid(pid.pid, 0, function(status) {
        console.log('process exited');
        console.log(status);
    });

    // write something to the pty
    setTimeout(function(){stdin.write('ls\r');}, 1000);
    setTimeout(function(){stdin.write('exit\r');}, 2000);
} else {
    // child - must exec early to work under OSX
    // NOTE: libuv event loop is dysfunctional after fork
    // if exec* fails all we can do here is exit

    //var error = own_module.execve('/bin/ls', ['/bin/ls', '-lR', '--color', '/usr/lib'], process.env);
    //var error = own_module.execle('/bin/bash', '/bin/bash', '-c', 'dd if=/dev/zero bs=1 count=65536 && echo -n "__sentinel__"', process.env);
    var error = own_module.execl('/bin/bash', '/bin/bash', '-l');
    //var error = own_module.execlp('bash', 'bash', '-l');
    //var error = own_module.execle('/bin/bash', '/bin/bash', '-l', process.env);
    //var error = own_module.execv('/bin/bash', ['/bin/bash', '-l']);
    //var error = own_module.execvp('bash', ['bash', '-l']);
    //var error = own_module.execve('/bin/bash', ['/bin/bash', '-l'], process.env);
    //var error = own_module.execl('/bin/ls', '/bin/ls', '-lR', '/usr/share');

    process.stderr.write(error);
    process.exit(-1);
}
