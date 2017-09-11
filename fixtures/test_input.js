var fs = require('fs');
var filecontent = fs.readFileSync('./fixtures/random_data', {encoding: 'binary'});

var buffer = '';
process.stdin.on('data', function(data) {
    buffer += data;
});

process.on('SIGHUP', function() {
    // drain stdin before exiting
    process.stdin.on('close', function() {
        process.exit(0);
    });
});

process.on('exit', function () {
    // stdin and stdout are already gone, use stderr
    process.stderr.write('' + (filecontent === buffer));
});
