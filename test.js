var own_module = require('./index');
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

    own_module.exec();
}
