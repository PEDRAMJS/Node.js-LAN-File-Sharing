# Node.js-LAN-File-Sharing ![version: beta](https://img.shields.io/badge/version-beta-orange)
A small Node.js app designed for sharing files while on the same network. Especially useful when you are trying to get a file from a friend and their device has a single broken USB port.

## Features
- Easy to use Drag and Drop file upload.
- Faster than uploading to a server then downloading since you are the server.
- Works with large files (tested with >2gb).
- The page opens fast due to being lightweight. (Native JS + ![vue 2.x](https://img.shields.io/badge/vue-2.x-brightgreen.svg))

## How to use
0. Clone (or download as zip) this project from github
0. Open terminal (or command line) in the project's folder.
0. Run ```npm install``` and then ```node main.js```.
0. The project will display your LAN ip and port (8080 by default) in the terminal once running.
0. On another device in the LAN, go to the *url:port*.
0. Drag & Drop any file in browser to transfer.

Project saves sent files in "files" folder. Also files in "files" folder can be downloaded from the browser.

PORT environment variable is used to change the port. e.g. ```export PORT=3030; node main.js```

### Secret key and admin panel
On start, the server reads the secret key from a file named `FSK` in the project folder. If there's no `FSK`, it asks for the key in the terminal (on first run you choose one, at least 12 characters). The server never creates or writes `FSK`, you create it yourself if you want unattended starts, and keep it private (`chmod 600 FSK`, it's in `.gitignore`). Until a key is given the server shows a "locked" page. The key encrypts the server's own data (`data/state.enc`): auto-delete dates, download limits, password protection flags, failed password attempts and settings. The server never stores it, so without it that data can't be read.

Settings (deletion, multi-file and folder uploads, limits, bans) are in the admin panel at `http://localhost:<port>/admin`. It only answers on the server machine itself, and asks for the secret key. It can also unlock a server that was started without a terminal.

```
node main.js [port] [files folder] [options]
  --data-dir <dir>          Where the encrypted state is kept (default: ./data)
  --secret-file <file>      Read the secret key from this file (default: FSK in the project folder)
  --https                   Serve HTTPS with a self-signed certificate
  --https-cert <file>       Serve HTTPS with your own certificate (with --https-key)
  --https-key <file>
  --debug-print-passwords   Print file passwords in the terminal when uploaded (insecure)
```

### Password protected files
Uploaders can protect files with a generated or their own password. The file is encrypted on disk with that password, so nobody (including the server owner) can open it without the password. After 10 wrong passwords an IP can't try again for 24 hours. Without `--https`, passwords travel over the network unencrypted.

## Screenshots

![Imgur](http://i.imgur.com/fxuSrmE.png)

Your LAN IP is shown on the page in addition to console output. Files in "files" directory are also listed for download.  

![Imgur](http://i.imgur.com/U4IFJsj.png)

Drag and Drop file upload. Archived without any javascript library.
