var own_module = require('./index');
var Termios = require('node-termios').Termios;
var net = require('net');

var pid = own_module.forkpty({termios: new Termios(0)});
if (pid.pid){
    var fds = own_module.get_fds(pid.master);
    var stdout = net.Socket({fd: fds.read, readable: true, writable: false});
    var stdin = net.Socket({fd: fds.write, readable: false, writable: true});
    stdout.on('data', function(data) {
        console.log(data.toString());
    });
    stdout.on('end', function() {
        console.log('pty stream end');
    });
    own_module.waitpid(pid.pid, 0, function(status) {
        console.log('process exited');
        console.log(status);
    });
    setTimeout(function(){stdin.write('ls\r');}, 1000);
    setTimeout(function(){stdin.write('exit\r');}, 2000);
} else {
    own_module.exec();
}
