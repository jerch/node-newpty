var own_module = require('./index');
var tty = require('tty');
var fs = require('fs');


var pid = own_module.forkpty();
if (pid.pid){
    console.log(pid);
    //var master = tty.ReadStream(pid.master);
    var master = fs.createReadStream('', {fd: pid.master});
    master.on('data', function(data) {
        console.log(data.toString());
    });
    master.on('error', function(err) {
        // nothing to do here for now
    });
    own_module.waitpid(pid.pid, 0, function(status) {
        console.log('process exited');
        console.log(status);
    });
} else {
    own_module.exec();
}
