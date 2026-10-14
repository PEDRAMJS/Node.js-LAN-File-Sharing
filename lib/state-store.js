// @ts-check
"use strict";

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

/*
 * Encrypted persistent state (config, file policies, bans) in a single file.
 * No database: one JSON document, encrypted with AES-256-GCM under a key
 * derived from the operator's secret with scrypt. The secret itself is never stored.
 *
 * File format (JSON): {v, kdf: {N, r, p, salt}, iv, tag, ct} -- binary fields are base64.
 */

const STATE_VERSION = 1;
const MIN_SECRET_LENGTH = 12;
// NOTE: 128 MiB memory, roughly half a second. Only runs on unlock and key rotation.
const STATE_KDF = { N: 2 ** 17, r: 8, p: 1 };
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const SAVE_DEBOUNCE_MS = 200;

class WrongSecretError extends Error {
    constructor() {
        super("Wrong secret key");
        this.name = "WrongSecretError";
    }
}

/**
 * @typedef StateConfig
 * @property {boolean} allowDeletion -- anyone may delete any file
 * @property {boolean} multiUpload
 * @property {boolean} folderUpload
 * @property {number} maxFileSize -- bytes
 * @property {number} maxAutoDeleteMinutes
 * @property {number} ownershipTtlMinutes -- how long uploaders may delete their uploads
 * @property {number} banThreshold -- failed password attempts per IP before a ban
 * @property {number} banHours
 * @property {number} minPasswordLength -- for user chosen file passwords
 * @property {boolean} trustProxy -- use X-Forwarded-For for client IPs
 */

/** @returns {StateConfig} */
function defaultConfig() {
    return {
        allowDeletion: false,
        multiUpload: false,
        folderUpload: false,
        maxFileSize: 100 * 1024 * 1024 * 1024, // 100GB
        maxAutoDeleteMinutes: 30 * 24 * 60, // 30 days
        ownershipTtlMinutes: 60,
        banThreshold: 10,
        banHours: 24,
        minPasswordLength: 8,
        trustProxy: false
    };
}

/**
 * @typedef StateData
 * @property {StateConfig} config
 * @property {Object<string, any>} policies -- relative file path => policy
 * @property {Object<string, {failures: Array<number>, bannedUntil: number|null}>} bans -- IP => attempts
 */

/** @param {Partial<StateConfig>} [configDefaults] @returns {StateData} */
function emptyState(configDefaults) {
    return {
        config: Object.assign(defaultConfig(), configDefaults || {}),
        policies: {},
        bans: {}
    };
}

/**
 * @param {string} secret
 * @param {Buffer} salt
 * @param {{N: number, r: number, p: number}} params
 * @returns {Promise<Buffer>}
 */
function deriveStateKey(secret, salt, params) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(secret.normalize('NFC'), salt, 32, {
            N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM
        }, (error, masterKey) => {
            if (error) return reject(error);
            // NOTE: Domain separated subkey, the master key is never used directly.
            const stateKey = crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'lfs-state-v1', 32);
            masterKey.fill(0);
            resolve(Buffer.from(stateKey));
        });
    });
}

class StateStore extends EventEmitter {
    /**
     * @param {string} dataDir
     * @param {Partial<StateConfig>} [configDefaults] -- used when creating a new state
     */
    constructor(dataDir, configDefaults) {
        super();
        this.dataDir = path.resolve(dataDir);
        this.statePath = path.join(this.dataDir, 'state.enc');
        this.configDefaults = configDefaults || {};
        /** @type {Buffer|null} */
        this._key = null;
        /** @type {{N: number, r: number, p: number, salt: Buffer}|null} */
        this._kdf = null;
        /** @type {StateData|null} */
        this._data = null;
        this._saveTimeout = null;
        this._saving = false;
        this._saveAgain = false;

        process.on('exit', () => this.flush());
    }

    static get MIN_SECRET_LENGTH() { return MIN_SECRET_LENGTH; }

    exists() {
        return fs.existsSync(this.statePath);
    }

    isUnlocked() {
        return this._data != null;
    }

    /** @returns {StateData} */
    get data() {
        if (this._data == null) throw new Error("StateStore is locked");
        return this._data;
    }

    /** @param {string} secret */
    static validateNewSecret(secret) {
        if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
            return `The secret key must be at least ${MIN_SECRET_LENGTH} characters.`;
        }
        return null;
    }

    /**
     * Creates a new state on first run.
     * @param {string} secret
     */
    async create(secret) {
        if (this.exists()) throw new Error("State already exists");
        const invalid = StateStore.validateNewSecret(secret);
        if (invalid) throw new Error(invalid);
        const salt = crypto.randomBytes(16);
        this._key = await deriveStateKey(secret, salt, STATE_KDF);
        this._kdf = Object.assign({ salt }, STATE_KDF);
        this._data = emptyState(this.configDefaults);
        fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
        this.saveSync();
        this.emit('unlocked');
    }

    /**
     * @param {string} secret
     * @throws {WrongSecretError}
     */
    async unlock(secret) {
        if (this.isUnlocked()) return;
        const envelope = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        if (envelope.v !== STATE_VERSION) throw new Error(`Unsupported state version ${envelope.v}`);
        const kdf = {
            N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p,
            salt: Buffer.from(envelope.kdf.salt, 'base64')
        };
        const key = await deriveStateKey(secret, kdf.salt, kdf);
        let plaintext;
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
            decipher.setAAD(Buffer.from(`lfs-state:${STATE_VERSION}`));
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ct, 'base64')), decipher.final()]);
        } catch (error) {
            key.fill(0);
            throw new WrongSecretError();
        }
        const stored = JSON.parse(plaintext.toString('utf8'));
        plaintext.fill(0);
        this._key = key;
        this._kdf = kdf;
        // NOTE: Fills in config keys added in newer versions.
        this._data = Object.assign(emptyState(this.configDefaults), stored);
        this._data.config = Object.assign(defaultConfig(), this.configDefaults, stored.config || {});
        this.emit('unlocked');
    }

    /**
     * @param {string} secret
     * @returns {Promise<boolean>} -- whether it's the secret of the unlocked state
     */
    async verifySecret(secret) {
        if (!this.isUnlocked()) throw new Error("StateStore is locked");
        const key = await deriveStateKey(secret, this._kdf.salt, this._kdf);
        const matches = crypto.timingSafeEqual(key, this._key);
        key.fill(0);
        return matches;
    }

    /**
     * Re-encrypts the state under a new secret.
     * @param {string} currentSecret
     * @param {string} newSecret
     */
    async rotate(currentSecret, newSecret) {
        if (!this.isUnlocked()) throw new Error("StateStore is locked");
        const invalid = StateStore.validateNewSecret(newSecret);
        if (invalid) throw new Error(invalid);
        if (!(await this.verifySecret(currentSecret))) throw new WrongSecretError();
        const salt = crypto.randomBytes(16);
        const newKey = await deriveStateKey(newSecret, salt, STATE_KDF);
        this._key.fill(0);
        this._key = newKey;
        this._kdf = Object.assign({ salt }, STATE_KDF);
        this.saveSync();
    }

    _encrypt() {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this._key, iv);
        cipher.setAAD(Buffer.from(`lfs-state:${STATE_VERSION}`));
        const ct = Buffer.concat([cipher.update(JSON.stringify(this._data), 'utf8'), cipher.final()]);
        return JSON.stringify({
            v: STATE_VERSION,
            kdf: { N: this._kdf.N, r: this._kdf.r, p: this._kdf.p, salt: this._kdf.salt.toString('base64') },
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ct: ct.toString('base64')
        });
    }

    /** Debounced save, call after changing `data`. */
    markDirty() {
        if (!this.isUnlocked() || this._saveTimeout != null) return;
        this._saveTimeout = setTimeout(() => {
            this._saveTimeout = null;
            this._saveAsync();
        }, SAVE_DEBOUNCE_MS);
    }

    _saveAsync() {
        if (this._saving) {
            this._saveAgain = true;
            return;
        }
        this._saving = true;
        const tmpPath = this.statePath + '.tmp';
        const content = this._encrypt();
        const done = (error) => {
            if (error) console.error("StateStore save error", error);
            this._saving = false;
            if (this._saveAgain) {
                this._saveAgain = false;
                this._saveAsync();
            }
        };
        fs.open(tmpPath, 'w', 0o600, (error, fd) => {
            if (error) return done(error);
            fs.write(fd, content, (error) => {
                if (error) return fs.close(fd, () => done(error));
                fs.fsync(fd, (error) => {
                    fs.close(fd, () => {
                        if (error) return done(error);
                        this._rotateBackup();
                        fs.rename(tmpPath, this.statePath, done);
                    });
                });
            });
        });
    }

    _rotateBackup() {
        try {
            fs.copyFileSync(this.statePath, this.statePath + '.bak');
        } catch (error) {
            if (error.code !== 'ENOENT') console.error("StateStore backup error", error);
        }
    }

    /** Writes pending changes now, for shutdown. */
    flush() {
        if (this._saveTimeout != null || this._saving) this.saveSync();
    }

    saveSync() {
        if (!this.isUnlocked()) return;
        if (this._saveTimeout != null) {
            clearTimeout(this._saveTimeout);
            this._saveTimeout = null;
        }
        const tmpPath = this.statePath + '.tmp';
        const fd = fs.openSync(tmpPath, 'w', 0o600);
        try {
            fs.writeSync(fd, this._encrypt());
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        this._rotateBackup();
        fs.renameSync(tmpPath, this.statePath);
    }
}

module.exports = { StateStore, WrongSecretError, defaultConfig };
