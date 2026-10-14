var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var { WrongSecretError, StateStore } = require('./lib/state-store');

var USAGE = [
    "Usage: node main.js [port] [files folder] [options]",
    "",
    "Options:",
    "  --data-dir <dir>          Where the encrypted state is kept (default: ./data)",
    "  --secret-file <file>      Read the secret key from this file (default: the FSK file in the project folder)",
    "  --https                   Serve HTTPS with a self-signed certificate",
    "  --https-cert <file>       Serve HTTPS with your own certificate (with --https-key)",
    "  --https-key <file>",
    "  --debug-print-passwords   Print file passwords in this terminal when uploaded (insecure)",
    "",
    "Secret key: put it in a file named FSK in the project folder, or type it when asked.",
    "The server never writes FSK, only the admin creates it.",
    "",
    "Settings like deletion and upload modes are in the admin panel: http(s)://localhost:<port>/admin"
].join("\n");

function parseArgs(argv) {
    var positional = [];
    var flags = {};
    var valueFlags = ["--data-dir", "--secret-file", "--https-cert", "--https-key"];
    var booleanFlags = ["--https", "--debug-print-passwords", "--help"];
    for (var i = 0; i < argv.length; i++) {
        var arg = argv[i];
        if (valueFlags.indexOf(arg) >= 0) {
            if (argv[i + 1] == null) throw new Error(arg + " needs a value");
            flags[arg] = argv[++i];
        } else if (booleanFlags.indexOf(arg) >= 0) {
            flags[arg] = true;
        } else if (arg.indexOf("--") === 0) {
            throw new Error("Unknown option " + arg);
        } else {
            positional.push(arg);
        }
    }
    return { positional: positional, flags: flags };
}

var args;
try {
    args = parseArgs(process.argv.slice(2));
} catch (error) {
    console.error(error.message + "\n\n" + USAGE);
    process.exit(1);
}
if (args.flags["--help"]) {
    console.log(USAGE);
    process.exit(0);
}

var dataDir = path.resolve(args.flags["--data-dir"] || path.join(__dirname, 'data'));
var useHttps = !!(args.flags["--https"] || args.flags["--https-cert"] || args.flags["--https-key"]);
var debugPrintPasswords = args.flags["--debug-print-passwords"] === true;

var tlsInfo = null;
if (useHttps) {
    var addresses = require('os').networkInterfaces();
    var ipv4 = [];
    Object.keys(addresses).forEach(function (name) {
        addresses[name].forEach(function (address) {
            if (address.family === 'IPv4' && !address.internal) ipv4.push(address.address);
        });
    });
    try {
        tlsInfo = require('./lib/tls').loadOrCreateTls({
            dataDir: dataDir,
            addresses: ipv4,
            certPath: args.flags["--https-cert"],
            keyPath: args.flags["--https-key"]
        });
    } catch (error) {
        console.error("HTTPS setup failed: " + error.message);
        process.exit(1);
    }
}

var fileShare = require('./fileshare')({
    filesFolderPath: (args.positional[1] || null),
    port: (args.positional[0] || process.env.PORT),
    dataDir: dataDir,
    https: useHttps,
    tlsInfo: tlsInfo && { fingerprint: tlsInfo.fingerprint, selfSigned: tlsInfo.selfSigned },
    debugPrintPasswords: debugPrintPasswords,
    progressCallback: function (progress, doneFileName) {
        //TODO: connect to UI when writing the electron app.
        if(progress != null) {
            console.log("Progress: " + Math.floor(progress) + "%");
        } else {
            console.log("Done file", doneFileName);
        }
    },
    errorCallback: function (url, err) {
        if (err.status == 404) {
            console.log("(Not Found) " + url);
        } else {
            console.log("(errorCallback) " + url);
            console.error(err);
        }
    }
});
var stateStore = fileShare.stateStore;
var scheme = useHttps ? 'https' : 'http';

var server = useHttps ?
    https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert }, fileShare.app) :
    http.createServer(fileShare.app);

function onError(error) {
    if (error.syscall !== 'listen') {
        throw error;
    }

    var bind = typeof port === 'string'
        ? 'Pipe ' + fileShare.port
        : 'Port ' + fileShare.port;

    // handle specific listen errors with friendly messages
    switch (error.code) {
        case 'EACCES':
            console.error(bind + ' requires elevated privileges');
            process.exit(1);
            break;
        case 'EADDRINUSE':
            console.error(bind + ' is already in use');
            process.exit(1);
            break;
        default:
            throw error;
    }
}

function onListening() {
    var addr = server.address();

    if (typeof addr === 'string') {
        console.log('Listening on pipe ' + addr);
    } else {
        fileShare.addresses.forEach(function (address) {
            console.log('Listening on ' + scheme + '://' + address + ':' + addr.port);
        });
        console.log('Admin panel (this machine only): ' + scheme + '://localhost:' + addr.port + '/admin');
    }
    if (tlsInfo) {
        console.log('HTTPS certificate SHA-256 fingerprint' + (tlsInfo.selfSigned ? ' (self-signed)' : '') + ':\n  ' + tlsInfo.fingerprint);
    }
    if (debugPrintPasswords) {
        console.log('\x1b[41m\x1b[37m WARNING \x1b[0m\x1b[31m --debug-print-passwords is on: file passwords will be printed in this terminal. Never use this in production.\x1b[0m');
    }
    unlockAtStartup();
}

/* Secret key */

var abortPrompt = null;

/**
 * Reads a line from the terminal without echoing it.
 * @returns {Promise<string|null>} -- null when aborted (unlocked from the admin panel)
 */
function promptHidden(question) {
    return new Promise(function (resolve) {
        var stdin = process.stdin;
        var value = '';
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        function cleanup() {
            stdin.removeListener('data', onData);
            stdin.setRawMode(false);
            stdin.pause();
            abortPrompt = null;
        }
        function onData(chunk) {
            for (var character of chunk) {
                if (character === '\r' || character === '\n') {
                    cleanup();
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                } else if (character === '\u0003') { // Ctrl+C
                    cleanup();
                    process.stdout.write('\n');
                    process.exit(130);
                } else if (character === '\u007f' || character === '\b') {
                    value = value.slice(0, -1);
                } else if (character >= ' ') {
                    value += character;
                }
            }
        }
        abortPrompt = function () {
            cleanup();
            process.stdout.write('\n');
            resolve(null);
        };
        stdin.on('data', onData);
    });
}

// NOTE: Signals skip the 'exit' handler by default, save pending state first.
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(function (signal) {
    process.on(signal, function () {
        try {
            stateStore.flush();
        } finally {
            process.exit(0);
        }
    });
});

stateStore.on('unlocked', function () {
    if (abortPrompt) abortPrompt();
    console.log('Server unlocked.');
});

async function unlockWithSecret(secret) {
    if (stateStore.exists()) {
        await stateStore.unlock(secret);
    } else {
        await stateStore.create(secret);
    }
}

// NOTE: Created by the admin only, the server never writes it.
var KEY_FILE_PATH = path.join(__dirname, 'FSK');

/** @returns {string|null} -- the key from FSK, null if it's missing or unusable */
function readKeyFile() {
    var content;
    try {
        content = fs.readFileSync(KEY_FILE_PATH, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') console.log('Could not read ' + KEY_FILE_PATH + ': ' + error.message);
        return null;
    }
    var secret = content.replace(/\r?\n$/, '');
    if (secret === '') {
        console.log(KEY_FILE_PATH + ' is empty, ignoring it.');
        return null;
    }
    if (process.platform !== 'win32' && (fs.statSync(KEY_FILE_PATH).mode & 0o077) !== 0) {
        console.log('\x1b[33mWarning: ' + KEY_FILE_PATH + ' can be read by other users on this machine. Run: chmod 600 FSK\x1b[0m');
    }
    return secret;
}

async function unlockAtStartup() {
    var secretFile = args.flags["--secret-file"];
    if (secretFile) {
        try {
            await unlockWithSecret(fs.readFileSync(secretFile, 'utf8').replace(/\r?\n$/, ''));
        } catch (error) {
            console.error('Could not unlock with --secret-file: ' + error.message);
            process.exit(1);
        }
        return;
    }
    var keyFileSecret = readKeyFile();
    if (keyFileSecret != null) {
        try {
            await unlockWithSecret(keyFileSecret);
            console.log('Unlocked with the key in ' + KEY_FILE_PATH + '.');
            return;
        } catch (error) {
            if (error instanceof WrongSecretError) {
                console.log('The key in ' + KEY_FILE_PATH + ' does not match the server data.');
            } else {
                console.log('Could not use the key in ' + KEY_FILE_PATH + ': ' + error.message);
            }
        }
    }
    if (!process.stdin.isTTY) {
        console.log('No terminal to ask for the secret key. The server stays locked until it is unlocked in the admin panel.');
        return;
    }
    console.log('The server is locked until the secret key is given (here, or in the admin panel).');
    while (!stateStore.isUnlocked()) {
        if (stateStore.exists()) {
            var secret = await promptHidden('Secret key: ');
            if (secret == null) return;
            try {
                await unlockWithSecret(secret);
            } catch (error) {
                if (error instanceof WrongSecretError) console.log('Wrong secret key, try again.');
                else throw error;
            }
        } else {
            var newSecret = await promptHidden('First run. Choose a secret key (at least ' + StateStore.MIN_SECRET_LENGTH + ' characters): ');
            if (newSecret == null) return;
            var invalid = StateStore.validateNewSecret(newSecret);
            if (invalid) {
                console.log(invalid);
                continue;
            }
            var repeated = await promptHidden('Repeat the secret key: ');
            if (repeated == null) return;
            if (repeated !== newSecret) {
                console.log('The keys did not match, try again.');
                continue;
            }
            await unlockWithSecret(newSecret);
            console.log('Keep this key safe. Without it, file settings and bans can not be read.');
            console.log('To start without typing it, put it in a file named FSK in ' + __dirname + ' (chmod 600).');
        }
    }
}

server.listen(fileShare.port);
server.on('error', onError);
server.on('listening', onListening);
