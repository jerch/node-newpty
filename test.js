var own_module = require('./index');
var tty = require('tty');
var fs = require('fs');
var Termios = require('node-termios').Termios;
var net = require('net');

/*
var pid = own_module.forkpty({termios: new Termios(0)});
if (pid.pid){
    console.log(pid);
    var master = tty.ReadStream(pid.master);
    //var master = fs.createReadStream('', {fd: pid.master});
    //var master_w = fs.createWriteStream('', {fd: pid.master});
    //setTimeout(function(){master_w.write('ls\r')}, 1000);
    //setTimeout(function(){master_w.write('exit\r')}, 2000);
    master.on('data', function(data) {
        console.log(data.toString());
    });
    master.on('error', function(err) {
        if (err.code == 'EIO') {
            //master.end();
            return;
        }
        if (err.code == 'EAGAIN')
            return;
        if (err.code == 'EBADF')
            return;
        throw err;
    });
    master.on('close', function() {
        console.log('pty stream end');
    });
    own_module.drain_fd(pid.master, function () {
        //fs.closeSync(pid.slave);
    });
    own_module.waitpid(pid.pid, 0, function(status) {
        console.log('process exited');
        console.log(status);
        //fs.closeSync(pid.slave);
        //own_module.drain_fd(pid.master, function () {
        //    console.log('master drained, closing slave...');
            //fs.closeSync(pid.slave);
        //});
        //fs.closeSync(pid.slave);
    }, pid.master, pid.slave);
} else {
    own_module.exec();
}
*/

var pid = own_module.forkpty({termios: new Termios(0)});
if (pid.pid){
    console.log(pid);
    var fds = own_module.get_fds(pid.master);
    var master = net.Socket(fds.read);

    master.on('data', function(data) {
        console.log(data.toString());
    });
    master.on('end', function() {
        console.log('pty stream end');
    });
    own_module.waitpid(pid.pid, 0, function(status) {
        console.log('process exited');
        console.log(status);
        //master.close();
        //fs.closeSync(pid.slave);
        //own_module.drain_fd(pid.master, function () {
        //    console.log('master drained, closing slave...');
        //fs.closeSync(pid.slave);
        //});
        //fs.closeSync(pid.slave);
    }, pid.master, pid.slave);
    //setTimeout(function(){}, 5000);
    //fs.close(fds.read);
} else {
    own_module.exec();
}
