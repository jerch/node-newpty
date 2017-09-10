var fs = require('fs');
var filecontent = fs.readFileSync('./fixtures/random_data', {encoding: 'binary'});

// get data from stdin
var buffer = '';
process.stdin.on('data', function(data) {
    buffer += data;
});

process.on('SIGHUP', function() {
    process.stdin.on('close', function() {
        process.exit(0);
    });
});

// print data and exit on SIGINT
process.on('exit', function () {
    process.stderr.write('' + (filecontent === buffer));
});