// @ts-check
"use_strict";

const express = require('express');
const formidable = require('formidable');
const path = require('path');
const fs = require('fs');
const os = require('os');
const qr_image = require("qr-image");
const crypto = require('crypto');
const { pipeline } = require('stream');
const util = require("util");
const chokidar = require('chokidar');
const { StateStore } = require('./lib/state-store');
const { AttemptLimiter } = require('./lib/attempt-limiter');
const fileCrypto = require('./lib/file-crypto');

/**
 * @callback FileShareProgressCallback
 * @param {number} progress
 * @param {string} fileName
 */

/**
 * @typedef FileShareConfig
 * @property {string} [filesFolderPath]
 * @property {string} [publicPath]
 * @property {number} [port]
 * @property {boolean} [allowDeletion]
 * @property {boolean} [multiUpload]
 * @property {boolean} [folderUpload]
 * @property {FileShareProgressCallback} [progressCallback]
 * @property {function} [errorCallback]
 * @property {number} [progressThreshold]
 * @property {boolean} [orderByTime]
 * @property {number} [maxFileSize]
 * @property {number} [maxAutoDeleteMinutes]
 * @property {{"info": boolean, "fileDownload": boolean}} [disable]
 */

/** @typedef {import('fs').Stats} FileStats */

/**
 * @typedef FolderContent
 * @property {true} folder
 * @property {string} name
 * @property {string} path
 * @property {Array<Content>} contents
 * @property {number} timestamp
 * // TODO(baris): size
 */
/**
 * @typedef FileContent
 * @property {false} folder
 * @property {string} name
 * @property {string} path
 * @property {number} timestamp
 * @property {number|null} [deleteAt] -- epoch ms (server clock) of auto-deletion
 * @property {number|null} [downloadsLeft] -- null for unlimited
 * // TODO(baris): size
 */
/**
 * @typedef {FolderContent|FileContent} Content
 */

/**
 * @typedef ServerInfoResult
 * @property {Array<string>} addresses
 * @property {number} port
 * @property {FolderContent} rootContent
 * @property {string} rootContentMD5
 * @property {boolean} allowDeletion
 * @property {boolean} multiUpload
 * @property {boolean} folderUpload
 * @property {number} maxAutoDeleteMinutes
 * @property {number} serverTime -- epoch ms, for client clock skew
 */

/**
 * @param {string} targetPath
 * @param {string} basePath
 * @param {string} [name=null]
 * @returns {Promise<FolderContent>}
 */
function recursiveReaddir(targetPath, basePath, name = null, orderByTime = false) {
    return readdirPromise(targetPath).then((contentNames) => {
        return Promise.all(contentNames.map((fileOrDirName) => {
            let fileOrDirPath = path.join(targetPath, fileOrDirName);
            return lstatPromise(fileOrDirPath).then(
                /** @returns {Content|Promise<Content>} */
                (stats) => {
                if (stats.isDirectory()) {
                    return recursiveReaddir(fileOrDirPath, basePath, fileOrDirName);
                } else if (stats.isFile()) {
                    /** @type {FileContent} */
                    const fileContent = {
                        "folder": false,
                        "name": fileOrDirName,
                        "path": path.relative(basePath, fileOrDirPath),
                        "timestamp": Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null)))
                    };
                    return fileContent;
                } else {
                    // NOTE(baris): Only handling file and folders
                    return null;
                }
            });
        }));
    }).then((contentObjects) => {
        if (contentObjects.length == 0 && targetPath != basePath) { // Ignoring empty (sub)folders
            return null;
        } else {
            let timestamp = null;
            if (contentObjects.length > 0) {
                contentObjects = contentObjects.filter(obj => (obj != null));
                if (orderByTime) {
                    contentObjects = contentObjects.sort((a, b) => {
                        if (a.timestamp == null) return 1;
                        if (b.timestamp == null) return -1;
                        return b.timestamp - a.timestamp;
                    });
                    timestamp = contentObjects[0].timestamp;
                } else {
                    timestamp = contentObjects.map((x) => x.timestamp).filter(x => (x != null)).sort((a, b) => b - a)[0];
                }
            }
            return {
                "folder": true,
                "name": name,
                "path": path.relative(basePath, targetPath),
                "contents": contentObjects,
                "timestamp": timestamp
            }
        }
    })
}
/**
 * @param {string} targetPath
 * @returns {Promise<Array<string>>}
 */
function readdirPromise(targetPath) {
    return new Promise((resolve) => {
        fs.readdir(targetPath, (err, contentNames) => {
            if (contentNames == null) {
                resolve([]);
            } else {
                // NOTE(baris): Ignoring hidden files all together.
                resolve(contentNames.filter((contentName) => contentName[0] != '.'));
            }
        })
    });
}
/**
 * @param {string} targetPath
 * @returns {Promise<FileStats>}
 */
function lstatPromise(targetPath) {
    return new Promise((resolve) => {
        fs.lstat(targetPath, (err, stats) => {
            resolve(stats);
        });
    });
}

//

/**
 * @param {string} msg
 * @param  {...any} args
 */
const logDebug = (
    (process.env.NODE_ENV === "debug") ?
    (msg, ...args) => {console.log(msg, ...args.map(arg => util.inspect(arg, false, 10, true)))} :
    (msg, ...args) => {}
)


/**
 * @typedef LiveCacheFolderContent
 * @property {true} folder
 * @property {string} path
 * @property {Object<string, LiveCacheContent>} contents
 * @property {number} timestamp
 * // TODO(baris): Sum size of files inside for size?
 */
/**
 * @typedef LiveCacheFileContent
 * @property {false} folder
 * @property {string} path
 * @property {number} timestamp
 * @property {number} size
 */
/**
 * @typedef {LiveCacheFolderContent|LiveCacheFileContent} LiveCacheContent
 */

class LiveCache {
    constructor(filesFolderPath, orderByTime=true) {
        
        this.orderByTime = orderByTime;
        
        /** @type {LiveCacheFolderContent} */
        const rootContent = {
            "folder": true,
            "path": "",
            "contents": {},
            "timestamp": null
        };
        this.rootContent = rootContent;
        
        const watcher = chokidar.watch(filesFolderPath, {
            cwd: filesFolderPath,
            ignored: /(^|[\/\\])\../, // ignore dotfiles
            persistent: true,
            alwaysStat: true,
        });
        this.watcher = watcher;
        
        watcher.on('error', error => {
            logDebug(`LiveCache: error`, error)
            // TODO(baris): Add error handling.
        })
        
        this.contentPrepPromise = new Promise((resolve) => {
            watcher.on('ready', () => {
                logDebug('Initial scan complete. Ready for changes')
                resolve();
            });
        })
        
        this._contentOutputJSON = null;
        this.contentOutputMD5 = null;

        /** @type {function(string): ({deleteAt: number|null, downloadsLeft: number|null, protected: boolean}|null)} */
        this.describeFile = null;

        /**
         * @param {string} pathStr
         * @returns {Array<string>}
         */
        function splitPath(pathStr) {
            if(pathStr == '') {
                return [];
            } else {
                return pathStr.split(path.sep);
            }
        }
        
        /**
         * @param {string} pathStr
         * @param {fs.Stats} stats
         */
        function addFolderToCache(pathStr, stats) {
            if(pathStr == "") {
                rootContent["timestamp"] = Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null)))
            } else {
                const pathParts = splitPath(pathStr);
                const partCount = pathParts.length;
                
                let currentDir = rootContent;
                for (let index = 0; index <= (partCount-2); index++) {
                    // @ts-ignore
                    currentDir = currentDir.contents[pathParts[index]];
                }
                currentDir.contents[pathParts[partCount-1]] = {
                    "folder": true,
                    "path": pathStr,
                    "contents": {},
                    // TODO(baris): Double check if valid for folders
                    "timestamp": Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null)))
                };
            }
        }
        /**
         * @param {string} pathStr
         * @param {fs.Stats} stats
         * NOTE(baris): Overwrites if in same path.
         */
        function addFileToCache(pathStr, stats) {
            if(pathStr == "") {
                console.error("addFileToCache root cannot be a file");
                return;
            }
            const pathParts = splitPath(pathStr);
            const partCount = pathParts.length;
            
            let currentDir = rootContent;
            for (let index = 0; index <= (partCount-2); index++) {
                // @ts-ignore
                currentDir = currentDir.contents[pathParts[index]];
            }
            currentDir.contents[pathParts[partCount-1]] = {
                "folder": false,
                "path": pathStr,
                "timestamp": Math.max(...[stats.ctimeMs, stats.mtimeMs].filter(x => (x != null))),
                "size": stats.size
            }
            
        }
        
        /**
         * @param {string} pathStr
         */
        function removeFromCache(pathStr) {
            if(pathStr == "") {
                console.error("removeFromCache root cannot be removed");
                return;
            }
            const pathParts = splitPath(pathStr);
            const partCount = pathParts.length;
            
            let currentDir = rootContent;
            for (let index = 0; index <= (partCount-2); index++) {
                // @ts-ignore
                currentDir = currentDir.contents[pathParts[index]];
            }
            delete currentDir.contents[pathParts[partCount-1]];
        }
        
        watcher
            .on('add', (path, stats) => {
                logDebug(`LiveCache: File has been added`, path, stats);
                this._invalidateOutputCache();
                addFileToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('change', (path, stats) => {
                logDebug(`LiveCache: File has been changed`, path, stats);
                this._invalidateOutputCache();
                addFileToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('unlink', path => {
                logDebug(`LiveCache: File has been removed`, path);
                this._invalidateOutputCache();
                removeFromCache(path);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('addDir',  (path, stats) => {
                logDebug(`LiveCache: Directory has been added`, path, stats);
                this._invalidateOutputCache();
                addFolderToCache(path, stats);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('unlinkDir', path => {
                logDebug(`LiveCache: Directory has been removed`, path);
                this._invalidateOutputCache();
                removeFromCache(path);
                logDebug(`LiveCache: rootContent`, rootContent);
            })
            .on('error', error => {
                console.error("LiveCache error:", error);
            })
        
    }
    
    /**
     * @param {string} baseFolderName
     * @param {LiveCacheFolderContent} baseFolderContent 
     * @returns {FolderContent}
     */
    _getContentRecursive(baseFolderName, baseFolderContent) {
        
        const contentNames = Object.keys(baseFolderContent.contents);
        
        if(contentNames.length == 0) return null;
        
        let contents = contentNames.map((contentName) => {
            const content = baseFolderContent.contents[contentName];
            if (content.folder) {
                return this._getContentRecursive(contentName, content);
            } else {
                /** @type {FileContent} */
                const fileContent = {
                    "folder": false,
                    "name": contentName,
                    "path": content.path,
                    "timestamp": content.timestamp
                }
                const policy = this.describeFile != null ? this.describeFile(content.path) : null;
                if (policy != null) {
                    fileContent.deleteAt = policy.deleteAt;
                    fileContent.downloadsLeft = policy.downloadsLeft;
                    if (policy.protected) fileContent.protected = true;
                }
                return fileContent;
            }
        }).filter(x => x != null);

        if (this.orderByTime) {
            contents = contents.sort((a, b) => {
                if (a.timestamp == null) return 1;
                if (b.timestamp == null) return -1;
                return b.timestamp - a.timestamp;
            });
        }
        
        return {
            "folder": true,
            "name": baseFolderName,
            "path": baseFolderContent.path,
            "contents": contents,
            // TODO(baris): Calculate timestamp from contents?
            "timestamp": baseFolderContent.timestamp,
        }
    }
    
    _invalidateOutputCache() {
        this._contentOutputJSON = null;
        this.contentOutputMD5 = null;
    }
    
    /**
     * Returns output content.
     * @returns {Promise<[FolderContent, string]>} -- [root folder content, md5]
     */
    prepContentOutput() {
        return this.contentPrepPromise.then(() => {
            // NOTE(baris): In class instance cache hit, independent of browser state.
            if(this.contentOutputMD5 == null) {
                this._contentOutputJSON = this._getContentRecursive(null, this.rootContent);
                this.contentOutputMD5 = crypto.createHash('md5').update(JSON.stringify(this._contentOutputJSON)).digest("hex")
            }
            return [this._contentOutputJSON, this.contentOutputMD5];
        });
    }
    
    // TODO(baris): attachUpdateListener
    // TODO(baris): detachUpdateListener
    
    destroy() {
        this.watcher.close().then(() => {
            logDebug("LiveCache destroy")
        })
    }
}

//

/**
 * Tracks which uploader may delete which file. The uploader receives a random
 * token that is only kept in their page's memory, so a refresh loses it.
 * Only the token hash is stored here, and only for `ttlMs`.
 */
class UploadOwnership {
    /** @param {function(): number} getTtlMs -- read on every grant, so config changes apply */
    constructor(getTtlMs) {
        this.getTtlMs = getTtlMs;
        /** @type {Map<string, {tokenHash: Buffer, expiresAt: number}>} */
        this.path2owner = new Map();
        const cleanupInterval = setInterval(() => this._removeExpired(), 5 * 60 * 1000);
        if (cleanupInterval.unref) cleanupInterval.unref();
    }

    static _hash(token) {
        return crypto.createHash('sha256').update(String(token)).digest();
    }

    _removeExpired() {
        const now = Date.now();
        for (const [filePath, owner] of this.path2owner) {
            if (owner.expiresAt <= now) this.path2owner.delete(filePath);
        }
    }

    /**
     * @param {Array<string>} filePaths -- relative to filesFolderPath
     * @returns {{token: string, expiresAt: number}}
     */
    grant(filePaths) {
        const token = crypto.randomBytes(32).toString('hex');
        const tokenHash = UploadOwnership._hash(token);
        const expiresAt = Date.now() + this.getTtlMs();
        filePaths.forEach((filePath) => {
            this.path2owner.set(filePath, { tokenHash, expiresAt });
        });
        return { token, expiresAt };
    }

    /**
     * @param {string} filePath
     * @param {string} token
     */
    isOwner(filePath, token) {
        const owner = this.path2owner.get(filePath);
        if (owner == null || typeof token !== 'string') return false;
        if (owner.expiresAt <= Date.now()) {
            this.path2owner.delete(filePath);
            return false;
        }
        return crypto.timingSafeEqual(owner.tokenHash, UploadOwnership._hash(token));
    }

    /** @param {string} filePath */
    revoke(filePath) {
        this.path2owner.delete(filePath);
    }
}

/**
 * @typedef FilePolicy
 * @property {number|null} deleteAt -- epoch ms, server clock
 * @property {number} maxDownloads -- -1 for unlimited
 * @property {number} downloadCount -- completed downloads
 * @property {boolean} [protected] -- password encrypted, see lib/file-crypto.js
 */

/**
 * Upload-time policies (auto-delete date, download limit, password protection) per file.
 * Persisted in the encrypted state, so only available once the server is unlocked.
 */
class FilePolicyStore {
    /**
     * @param {string} filesFolderPath
     * @param {StateStore} stateStore
     * @param {function(string): void} onFileDeleted -- called with relative path
     * @param {function(): void} onChange
     */
    constructor(filesFolderPath, stateStore, onFileDeleted, onChange) {
        this.filesFolderPath = path.resolve(filesFolderPath);
        this.stateStore = stateStore;
        this.onFileDeleted = onFileDeleted;
        this.onChange = onChange;
        /** @type {Map<string, number>} -- downloads in progress */
        this.inFlight = new Map();

        const sweepInterval = setInterval(() => this.sweep(), 15 * 1000);
        if (sweepInterval.unref) sweepInterval.unref();

        if (stateStore.isUnlocked()) this._activate();
        else stateStore.once('unlocked', () => this._activate());
    }

    /** @returns {Object<string, FilePolicy>} */
    get _policies() {
        return this.stateStore.isUnlocked() ? this.stateStore.data.policies : {};
    }

    _activate() {
        this._migrateLegacyStore();
        const policies = this._policies;
        let dropped = false;
        Object.keys(policies).forEach((filePath) => {
            if (!fs.existsSync(path.join(this.filesFolderPath, filePath))) {
                delete policies[filePath];
                dropped = true;
            }
        });
        if (dropped) this.stateStore.markDirty();
        // NOTE: Catches up on files that expired while the server was down or locked.
        this.sweep();
        this.onChange();
    }

    /** Moves policies from the old plaintext dotfile into the encrypted state. */
    _migrateLegacyStore() {
        const legacyPath = path.join(this.filesFolderPath, '.fileshare-policies.json');
        let legacy;
        try {
            legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') console.error("FilePolicyStore legacy store read error", error);
            return;
        }
        const policies = this._policies;
        Object.keys(legacy || {}).forEach((filePath) => {
            if (policies[filePath] == null) policies[filePath] = legacy[filePath];
        });
        this.stateStore.saveSync();
        fs.unlinkSync(legacyPath);
        console.log("Moved file policies from .fileshare-policies.json into the encrypted state.");
    }

    /**
     * @param {string} filePath
     * @returns {FilePolicy|undefined}
     */
    get(filePath) {
        return this._policies[filePath];
    }

    /** @returns {Array<[string, FilePolicy]>} */
    entries() {
        const policies = this._policies;
        return Object.keys(policies).map((filePath) => [filePath, policies[filePath]]);
    }

    /**
     * @param {string} filePath
     * @param {FilePolicy|null} policy -- null clears any stale policy
     */
    set(filePath, policy) {
        const policies = this._policies;
        if (policy == null) {
            if (policies[filePath] == null) return;
            delete policies[filePath];
        } else {
            policies[filePath] = policy;
        }
        this.stateStore.markDirty();
        this.onChange();
    }

    /** @param {string} filePath */
    remove(filePath) {
        this.set(filePath, null);
    }

    /** @param {string} filePath */
    deleteFile(filePath) {
        this.remove(filePath);
        fs.unlink(path.join(this.filesFolderPath, filePath), (error) => {
            if (error && error.code !== 'ENOENT') console.error("FilePolicyStore unlink error", error);
        });
        this.onFileDeleted(filePath);
    }

    sweep() {
        const now = Date.now();
        this.entries().forEach(([filePath, policy]) => {
            if (policy.deleteAt != null && policy.deleteAt <= now) {
                logDebug("FilePolicyStore auto-delete expired", filePath);
                this.deleteFile(filePath);
            }
        });
    }

    /**
     * @param {string} filePath
     * @returns {boolean} -- false if no download slot is left
     */
    tryAcquire(filePath) {
        const policy = this.get(filePath);
        if (policy == null || policy.maxDownloads < 0) return true;
        const inFlight = this.inFlight.get(filePath) || 0;
        if (policy.downloadCount + inFlight >= policy.maxDownloads) return false;
        this.inFlight.set(filePath, inFlight + 1);
        return true;
    }

    /**
     * @param {string} filePath
     * @param {boolean} success -- whole file was sent without error
     */
    release(filePath, success) {
        if (this.inFlight.has(filePath)) {
            const inFlight = this.inFlight.get(filePath) - 1;
            if (inFlight > 0) this.inFlight.set(filePath, inFlight);
            else this.inFlight.delete(filePath);
        }
        const policy = this.get(filePath);
        if (!success || policy == null || policy.maxDownloads < 0) return;
        policy.downloadCount += 1;
        if (policy.downloadCount >= policy.maxDownloads) {
            logDebug("FilePolicyStore download limit reached", filePath);
            this.deleteFile(filePath);
        } else {
            this.stateStore.markDirty();
            this.onChange();
        }
    }

    /**
     * @param {string} filePath
     * @returns {{deleteAt: number|null, downloadsLeft: number|null, protected: boolean}|null}
     */
    describe(filePath) {
        const policy = this.get(filePath);
        if (policy == null) return null;
        return {
            "deleteAt": policy.deleteAt,
            "downloadsLeft": policy.maxDownloads < 0 ? null : (policy.maxDownloads - policy.downloadCount),
            "protected": policy.protected === true
        };
    }
}

function normalizePort(val) {
    const port = parseInt(val, 10);

    if (isNaN(port)) {
        // named pipe
        return val;
    }

    if (port >= 0) {
        // port number
        return port;
    }

    return false;
}

function getAddresses() {
    let interfaces = os.networkInterfaces();
    let addresses = [];
    for (const k in interfaces) {
        for (const k2 in interfaces[k]) {
            let address = interfaces[k][k2];
            // NOTE: Only handling IPv4 at the moment.
            if (address.family === 'IPv4' && !address.internal) {
                addresses.push(address.address);
            }
        }
    }
    return addresses;
}

function generateQRCodeIfNotExists(imagePath, scheme, address, port) {
    return new Promise((resolve, reject) => {
        fs.exists(imagePath, function (exists) {
            if (exists) {
                resolve();
            } else {
                let qr_svg = qr_image.image(`${scheme}://${address}:${port}/`, { type: 'png' });
                qr_svg.pipe(fs.createWriteStream(imagePath))
                    .on("finish", () => { resolve(); })
                    .on("error", () => { reject(); });
            }
        })
    })
}

/**
 * @param {string} scheme
 * @param {string} address
 * @param {number} port
 */
function qrCodeFileName(scheme, address, port) {
    return `${scheme === 'https' ? 'https_' : ''}${address}_${port}.png`;
}

function getAddressesWQRCodes(publicPath, scheme, port) {
    const addresses = getAddresses();
    return Promise.all(addresses.map((address) => {
        const imagePath = path.join(publicPath, './qr_codes/', qrCodeFileName(scheme, address, port));
        return generateQRCodeIfNotExists(imagePath, scheme, address, port).catch(() => {
            // NOTE(baris): Ignoring errors here.
        });
    })).then(() => addresses);
}

const LOCKED_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>LAN File Sharing - locked</title>
<style>body{font-family:-apple-system,Roboto,Helvetica,Arial,sans-serif;text-align:center;padding:15vh 16px;color:#333}
@media (prefers-color-scheme: dark){body{background:#111;color:#eee}}</style></head>
<body><h1>Server is locked</h1><p>The admin needs to unlock it on the server machine.</p>
<p>This page reloads by itself.</p><script>setTimeout(function(){location.reload()},10000)</script></body></html>`;

/**
 * @param {FileShareConfig} conf
 */
module.exports = function (conf) {

    //Getting config from conf.
    let filesFolderPath = path.resolve(conf.filesFolderPath || path.join(__dirname, 'files')),
        publicPath = conf.publicPath || path.join(__dirname, 'public'),
        dataDir = conf.dataDir || path.join(__dirname, 'data'),
        port = normalizePort(conf.port || '8080'),
        scheme = conf.https ? 'https' : 'http',
        progressCallback = conf.progressCallback,
        errorCallback = conf.errorCallback,
        progressThreshold = conf.progressThreshold || 10,
        orderByTime = conf.orderByTime || true,
        debugPrintPasswords = conf.debugPrintPasswords === true,
        disable = conf.disable || {"info": false, "fileDownload": false};

    // NOTE: Only used as defaults when a new (encrypted) state is created, after that the admin panel owns them.
    /** @type {Partial<import('./lib/state-store').StateConfig>} */
    const configDefaults = {};
    ["allowDeletion", "multiUpload", "folderUpload", "maxFileSize", "maxAutoDeleteMinutes"].forEach((key) => {
        if (conf[key] != null) configDefaults[key] = conf[key];
    });

    const vueDistPath = path.join(__dirname, "./node_modules/vue/dist");

    let qrCodesPath = path.join(publicPath, "./qr_codes/");
    if (!fs.existsSync(qrCodesPath)) {
        fs.mkdirSync(qrCodesPath);
    }

    const stateStore = new StateStore(dataDir, configDefaults);
    /** @returns {import('./lib/state-store').StateConfig} */
    const cfg = () => stateStore.data.config;

    const liveCache = new LiveCache(filesFolderPath, orderByTime);
    const uploadOwnership = new UploadOwnership(() => cfg().ownershipTtlMinutes * 60 * 1000);
    const policyStore = new FilePolicyStore(
        filesFolderPath,
        stateStore,
        (filePath) => uploadOwnership.revoke(filePath),
        () => liveCache._invalidateOutputCache()
    );
    liveCache.describeFile = (filePath) => policyStore.describe(filePath);
    const attemptLimiter = new AttemptLimiter(stateStore);
    // NOTE: Each password check costs ~32MB and ~100ms, never run many at once.
    const kdfQueue = new fileCrypto.KdfQueue(2);

    /**
     * @param {string} relativePath
     * @returns {string|null} -- full path if it is inside filesFolderPath
     */
    function resolveInsideFilesFolder(relativePath) {
        const fileFullPath = path.join(filesFolderPath, relativePath);
        if (
            fileFullPath != filesFolderPath &&
            fileFullPath.startsWith(filesFolderPath + path.sep)
        ) {
            return fileFullPath;
        }
        return null;
    }

    /** @param {import('express').Request} req */
    function clientIp(req) {
        let ip = req.socket.remoteAddress || '';
        const forwardedFor = req.headers['x-forwarded-for'];
        if (cfg().trustProxy && typeof forwardedFor === 'string' && forwardedFor != '') {
            ip = forwardedFor.split(',')[0].trim();
        }
        return ip.replace(/^::ffff:/, '');
    }

    /**
     * Counts a download against its limit. Only a complete 200 response counts.
     * @param {string} filePath
     * @param {import('express').Response} res
     * @returns {boolean} -- false if no download is left
     */
    function trackDownload(filePath, res) {
        if (!policyStore.tryAcquire(filePath)) return false;
        let released = false;
        const release = (success) => {
            if (released) return;
            released = true;
            policyStore.release(filePath, success);
        };
        // NOTE: 'finish' = last byte handed to the OS, the best HTTP can tell us.
        res.on('finish', () => release(res.statusCode === 200));
        res.on('close', () => release(false));
        return true;
    }

    /**
     * Unlocked protected files, the browser downloads them with a GET.
     * NOTE: In memory, single use, short lived and bound to the client IP.
     * @type {Map<string, {path: string, ip: string, header: any, fileKey: Buffer, expiresAt: number}>}
     */
    const downloadTickets = new Map();
    const ticketCleanupInterval = setInterval(() => {
        const now = Date.now();
        downloadTickets.forEach((ticket, id) => {
            if (ticket.expiresAt <= now) {
                ticket.fileKey.fill(0);
                downloadTickets.delete(id);
            }
        });
    }, 60 * 1000);
    if (ticketCleanupInterval.unref) ticketCleanupInterval.unref();

    //New express app
    const app = express();
    app.disable('x-powered-by');

    // NOTE: Admin panel is reachable while locked, it's how a headless server gets unlocked.
    app.use('/admin', require('./lib/admin')({
        stateStore,
        attemptLimiter,
        policyStore,
        filesFolderPath,
        resolveInsideFilesFolder,
        debugPrintPasswords,
        getTlsInfo: () => conf.tlsInfo || null
    }));

    // Locked mode: without the secret key we don't know expiry dates, limits or bans.
    app.use(function (req, res, next) {
        if (stateStore.isUnlocked()) return next();
        res.status(503).set('Retry-After', '10').type('html').send(LOCKED_PAGE);
    });

    //For index. Basically app.get('/',...);
    app.use(express.static(publicPath));

    //For vue.js
    app.use('/vue', express.static(vueDistPath));

    //For downloading files
    if (!disable.fileDownload) {
        // Enforces password protection and download limits.
        app.use('/f', function (req, res, next) {
            if (req.method !== 'GET' && req.method !== 'HEAD') return next();
            let filePath;
            try {
                filePath = path.normalize(decodeURIComponent(req.path).replace(/^\/+/, ''));
            } catch (error) {
                return next();
            }
            const policy = policyStore.get(filePath);
            if (policy == null) return next();
            if (policy.protected) {
                res.status(403).send("This file is password protected.");
                return;
            }
            if (req.method !== 'GET' || policy.maxDownloads < 0) return next();
            if (!trackDownload(filePath, res)) {
                res.sendStatus(410);
                return;
            }
            // NOTE: No partial/resumed downloads, they can't be counted reliably.
            delete req.headers.range;
            res.setHeader('Cache-Control', 'no-store');
            next();
        });
        app.use('/f', express.static(filesFolderPath));
    }

    // Checks a password and hands out a one time download ticket.
    app.post('/unlock', express.json({ limit: '4kb' }), async function (req, res, next) {
        try {
            const ip = clientIp(req);
            const body = req.body || {};
            if (typeof body.path !== 'string' || typeof body.password !== 'string' || body.password.length > 1024) {
                res.sendStatus(400);
                return;
            }
            const filePath = path.normalize(body.path);

            const status = attemptLimiter.status(ip);
            if (status.banned) {
                res.status(429).json({ "attemptsLeft": 0, "bannedUntil": status.bannedUntil });
                return;
            }
            const policy = policyStore.get(filePath);
            const fileFullPath = resolveInsideFilesFolder(filePath);
            if (policy == null || !policy.protected || fileFullPath == null) {
                res.sendStatus(404);
                return;
            }
            let header;
            try {
                ({ header } = await fileCrypto.readHeader(fileFullPath));
            } catch (error) {
                res.sendStatus(404);
                return;
            }
            if (header == null) {
                console.error("unlock: not an encrypted file", filePath);
                res.sendStatus(500);
                return;
            }

            const delayMs = attemptLimiter.fileDelayMs(filePath);
            if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
            const kek = await kdfQueue.run(() => fileCrypto.deriveKek(body.password, header.kdf));
            const fileKey = fileCrypto.unwrapFileKey(header, kek);
            kek.fill(0);

            // NOTE: Re-checked after the slow part, parallel guesses must not get past the limit.
            const statusNow = attemptLimiter.status(ip);
            if (statusNow.banned) {
                if (fileKey) fileKey.fill(0);
                res.status(429).json({ "attemptsLeft": 0, "bannedUntil": statusNow.bannedUntil });
                return;
            }
            if (fileKey == null) {
                const failed = attemptLimiter.recordFailure(ip, filePath);
                res.status(failed.banned ? 429 : 401).json({
                    "attemptsLeft": failed.attemptsLeft,
                    "bannedUntil": failed.bannedUntil
                });
                return;
            }

            const ticket = crypto.randomBytes(32).toString('base64url');
            downloadTickets.set(ticket, {
                path: filePath, ip, header, fileKey, expiresAt: Date.now() + 2 * 60 * 1000
            });
            res.json({ "ticket": ticket, "attemptsLeft": statusNow.attemptsLeft });
        } catch (error) {
            next(error);
        }
    });

    // Streams a decrypted protected file for a ticket from /unlock.
    app.get('/d/:ticket', function (req, res) {
        const ticket = downloadTickets.get(req.params.ticket);
        downloadTickets.delete(req.params.ticket);
        if (ticket == null || ticket.expiresAt <= Date.now() || ticket.ip !== clientIp(req)) {
            if (ticket) ticket.fileKey.fill(0);
            res.status(410).send("This download link has expired, unlock the file again.");
            return;
        }
        const fileFullPath = resolveInsideFilesFolder(ticket.path);
        if (policyStore.get(ticket.path) == null || fileFullPath == null) {
            ticket.fileKey.fill(0);
            res.sendStatus(404);
            return;
        }
        fs.stat(fileFullPath, (error, stats) => {
            if (error) {
                ticket.fileKey.fill(0);
                res.sendStatus(404);
                return;
            }
            if (!trackDownload(ticket.path, res)) {
                ticket.fileKey.fill(0);
                res.sendStatus(410);
                return;
            }
            const fileName = path.basename(ticket.path);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
            res.setHeader('Content-Length', String(fileCrypto.plaintextSize(stats.size, ticket.header)));
            res.setHeader('Cache-Control', 'no-store');
            pipeline(
                fs.createReadStream(fileFullPath, { start: fileCrypto.HEADER_SIZE }),
                fileCrypto.createDecryptStream(ticket.header, ticket.fileKey),
                res,
                (error) => {
                    ticket.fileKey.fill(0);
                    // NOTE: Tampered or truncated file, the client sees a failed download.
                    if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error("protected download error", ticket.path, error.message);
                }
            );
        });
    });

    app.get('/delete/:filename', function (req, res) {
        
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // Just in case
        res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,contenttype'); // Just in case
        res.setHeader('Access-Control-Allow-Credentials', "true"); // Just in case

        if (cfg().allowDeletion) {
            const filename = decodeURIComponent(req.params.filename);
            const fileFullPath = resolveInsideFilesFolder(filename);
            logDebug("fileFullPath", fileFullPath);
            if(fileFullPath != null) {
                try {
                    fs.unlinkSync(fileFullPath)
                    uploadOwnership.revoke(path.relative(filesFolderPath, fileFullPath));
                    policyStore.remove(path.relative(filesFolderPath, fileFullPath));
                    res.sendStatus(200);
                } catch (error) {
                    error.status = 404;
                    console.error("fs.unlinkSync error", error);
                    res.send();
                }
            } else {
                res.statusCode = 500;
                res.send("Invalid filename");
            }
        } else {
            res.sendStatus(500);
        }

    });

    // Lets an uploader delete their own files with the token they got on upload.
    app.post('/delete-own', express.json({ limit: '10kb' }), function (req, res) {
        const filePath = req.body && req.body.path;
        const token = req.body && req.body.token;
        if (typeof filePath !== 'string' || typeof token !== 'string') {
            res.sendStatus(400);
            return;
        }
        const relativePath = path.normalize(filePath);
        if (!uploadOwnership.isOwner(relativePath, token)) {
            res.sendStatus(403);
            return;
        }
        const fileFullPath = resolveInsideFilesFolder(relativePath);
        if (fileFullPath == null) {
            res.sendStatus(400);
            return;
        }
        fs.unlink(fileFullPath, (error) => {
            uploadOwnership.revoke(relativePath);
            policyStore.remove(relativePath);
            if (error) {
                console.error("delete-own unlink error", error);
                res.sendStatus(404);
            } else {
                res.sendStatus(200);
            }
        });
    });

    app.post('/', function (req, res) {

        // Bug fix for when the filesFolderPath folder does not exists
        fs.mkdirSync(filesFolderPath, { recursive: true });

        const form = new formidable.IncomingForm();
        
        form.uploadDir = filesFolderPath;
        
        form.maxFields = 10000;
        form.multiples = true;
        form.maxFileSize = cfg().maxFileSize;
        
        let progress = 0;
        form.on('progress', function (bytesReceived, bytesExpected) {
            const temp = bytesReceived * 100 / bytesExpected;
            if (temp > progress + progressThreshold) {
                progress = Math.floor(temp);
                if (progressCallback) progressCallback(progress, null);
            }
        });
        
        // NOTE: Policy fields must be sent before the files, they are locked after upload.
        let deleteAfterMinutes = null;
        let maxDownloads = -1;
        /** @type {"auto"|"manual"|null} */
        let protectMode = null;
        let manualPassword = null;
        let fileStarted = false;
        let policyError = null;
        form.on('field', function (name, value) {
            if (fileStarted && ['deleteAfterMinutes', 'maxDownloads', 'protect', 'password'].includes(name)) {
                if (policyError == null) policyError = `${name} must be sent before the files`;
                return;
            }
            if (name === 'protect') {
                if (value === 'auto' || value === 'manual') protectMode = value;
                else if (policyError == null) policyError = "Invalid protect";
                return;
            }
            if (name === 'password') {
                manualPassword = value;
                return;
            }
            if (name !== 'deleteAfterMinutes' && name !== 'maxDownloads') return;
            const number = Number(value);
            let valid = Number.isInteger(number);
            if (valid && name === 'deleteAfterMinutes') {
                valid = (number >= 1 && number <= cfg().maxAutoDeleteMinutes);
                deleteAfterMinutes = number;
            } else if (valid) {
                valid = (number === -1 || number >= 1);
                maxDownloads = number;
            }
            // NOTE: formidable 1.x keeps writing files even after an error, so flag and clean up.
            if (!valid && policyError == null) policyError = `Invalid ${name}`;
        });

        /**
         * One password (and key derivation) for the whole upload batch.
         * @type {{kdf: import('./lib/file-crypto').KdfParams, kekPromise: Promise<Buffer>, password: string}|null}
         */
        let protection = null;
        function prepareProtection() {
            if (protection != null || protectMode == null) return;
            let password;
            if (protectMode === 'auto') {
                password = fileCrypto.generatePassword();
            } else if (
                typeof manualPassword === 'string' &&
                manualPassword.length >= cfg().minPasswordLength &&
                manualPassword.length <= 1024
            ) {
                password = manualPassword;
            } else {
                if (policyError == null) policyError = "Invalid password";
                return;
            }
            const kdf = fileCrypto.newKdfParams();
            const kekPromise = kdfQueue.run(() => fileCrypto.deriveKek(password, kdf));
            kekPromise.catch(() => {});
            protection = { kdf, kekPromise, password };
        }

        const foldersCreated = new Map(); // given folder => duplicate handled folder
        form.on('fileBegin', function (webkitRelativePath, file) {
            
            logDebug("fileBegin", webkitRelativePath, file);
            fileStarted = true;
            
            let {dir:parsedPathDir, name:parsedPathName, ext:parsedPathExt} = path.parse(webkitRelativePath);
            if(parsedPathDir != "") {
                // Borrowed from: https://stackoverflow.com/a/41970204
                parsedPathDir = parsedPathDir.split(path.sep).reduce((currentPath, folder, index) => {
                    let combinedPath = [currentPath, folder, path.sep].join('');
                    if(index == 0) {
                        if(foldersCreated.has(folder)) {
                            combinedPath = [currentPath, foldersCreated.get(folder), path.sep].join('');
                        } else {
                            let i = 0;
                            let handledFolder = folder;
                            while(fs.existsSync(path.join(filesFolderPath, combinedPath))) {
                                handledFolder = [folder, " dup", (i++)].join('');
                                combinedPath = [currentPath, handledFolder, path.sep].join('');
                            }
                            foldersCreated.set(folder, handledFolder);
                            fs.mkdirSync(path.join(filesFolderPath, combinedPath));
                        }
                    } else {
                        if (!fs.existsSync(path.join(filesFolderPath, combinedPath))) {
                            logDebug("combinedPath", combinedPath);
                            fs.mkdirSync(path.join(filesFolderPath, combinedPath));
                        }
                    }
                    return combinedPath;
                }, '');
            }
            
            let fileName = parsedPathName + parsedPathExt;
            let filePath = path.join(filesFolderPath, parsedPathDir, fileName);
            
            //For not overwriting files.
            let i = 0;
            while (fs.existsSync(filePath)) {
                fileName = [parsedPathName, " dup", (i++), ".", parsedPathExt].join('');
                filePath = path.join(filesFolderPath, parsedPathDir, fileName);
            }

            file.path = filePath;

            if (policyError == null) prepareProtection();
            if (policyError != null) {
                // NOTE: Rejected upload, nothing is written to disk.
                file.open = function () { this._writeStream = fileCrypto.createDiscardSink(); };
            } else if (protection != null) {
                // NOTE: Encrypted while streaming, plaintext never touches the disk.
                const { kekPromise, kdf } = protection;
                file.open = function () {
                    this._writeStream = fileCrypto.createEncryptingFileSink(filePath, kekPromise, kdf);
                };
            }

        });
        
        /** @type {Array<string>} */
        const uploadedPaths = [];
        form.on('file', function (name, file) {
            logDebug("file done", name, file);
            const relativePath = path.relative(filesFolderPath, file.path);
            uploadedPaths.push(relativePath);
            if (policyError != null) return;
            // NOTE: Set as soon as the file is done, so no download slips past the limit.
            policyStore.set(relativePath, (deleteAfterMinutes == null && maxDownloads < 0 && protection == null) ? null : {
                "deleteAt": deleteAfterMinutes == null ? null : (Date.now() + deleteAfterMinutes * 60 * 1000),
                "maxDownloads": maxDownloads,
                "downloadCount": 0,
                "protected": protection != null
            });
            if (progressCallback) progressCallback(null, file.name);
        });

        form.parse(req, (error, fields, files) => {
            if (policyError != null || error != null) {
                // NOTE: Don't keep files from a rejected or broken upload.
                uploadedPaths.forEach((relativePath) => {
                    policyStore.remove(relativePath);
                    fs.unlink(path.join(filesFolderPath, relativePath), () => {});
                });
            }
            if (policyError != null) {
                console.error("upload policy error", policyError);
                res.status(400).send(policyError);
            } else if(error != null) {
                console.error("form error", error);
                res.sendStatus(400);
            } else {
                // logDebug("files", files);
                logDebug("file uploads done");
                if (protection != null && debugPrintPasswords) {
                    console.log(`\x1b[31m[DEBUG] password for ${uploadedPaths.join(', ')}: ${protection.password}\x1b[0m`);
                }
                if (req.accepts(['text', 'json']) === 'json') {
                    // NOTE: Only the page that made the upload gets the token (and an auto password).
                    const { token } = uploadOwnership.grant(uploadedPaths);
                    // NOTE: Relative expiry, client and server clocks may differ.
                    res.json({
                        "paths": uploadedPaths,
                        "token": token,
                        "expiresInMs": uploadOwnership.getTtlMs(),
                        "deleteAfterMinutes": deleteAfterMinutes,
                        "maxDownloads": maxDownloads,
                        "protected": protection != null,
                        "password": (protection != null && protectMode === 'auto') ? protection.password : null
                    });
                } else {
                    res.sendStatus(200);
                }
            }
        });

    });

    app.get('/info', function (req, res) {

        if (disable.info) {
            res.sendStatus(404);
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE'); // Just in case
        res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,contenttype'); // Just in case
        res.setHeader('Access-Control-Allow-Credentials', "true"); // Just in case
        
        const addressesPromise = getAddressesWQRCodes(publicPath, scheme, port);
        
        /** @type {Promise<[FolderContent, string]>} */
        let rootContentPromise;
        if(disable.fileDownload) {
            rootContentPromise = Promise.resolve([null, null]);
        } else if(req.query.md5 != null && liveCache.contentOutputMD5 === req.query.md5) {
            // NOTE(baris): In browser cache hit case. Browser will not update.
            rootContentPromise = Promise.resolve([null, liveCache.contentOutputMD5]);
        } else {
            rootContentPromise = liveCache.prepContentOutput();
        }

        Promise.all([
            addressesPromise,
            rootContentPromise
        ]).then(([addresses, [rootContent, rootContentMD5]]) => {

            const config = cfg();
            /** @type {ServerInfoResult} */
            const info = {
                "addresses": addresses,
                "port": port,
                "scheme": scheme,
                "allowDeletion": config.allowDeletion,
                "multiUpload": config.multiUpload,
                "folderUpload": config.folderUpload,
                "rootContent": rootContent,
                "rootContentMD5": rootContentMD5,
                "maxAutoDeleteMinutes": config.maxAutoDeleteMinutes,
                "minPasswordLength": config.minPasswordLength,
                "serverTime": Date.now()
            };

            res.json(info);
        })

    });

    // catch 404
    app.use(function (req, res, next) {
        if (errorCallback) { // NOTE(baris): Preserved for backwards compatibility.
            var err = new Error('Not Found');
            // @ts-ignore
            err.status = 404;
            // development error handler
            errorCallback(req.url, err);
        }
        res.sendStatus(404);
    });

    app.use(function (err, req, res, next) {
        // development error handler
        if (errorCallback) errorCallback(req.url, err);
        res.sendStatus(500);
    });

    app.set('port', port);

    return {
        "addresses": getAddresses(),
        "app": app,
        "stateStore": stateStore,
        "disable": disable, // For manual debugging.
        "port": port
    };

};
