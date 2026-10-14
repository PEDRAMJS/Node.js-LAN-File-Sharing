// @ts-check
"use strict";

const crypto = require('crypto');
const fs = require('fs');
const { Transform, Writable } = require('stream');

/*
 * Password-encrypted files. The password is never stored: it derives a key
 * (scrypt) that wraps a random per-file key. Checking a password means trying
 * to unwrap that key, so the file is self-contained and only its password opens it.
 *
 * Layout:
 *   header (HEADER_SIZE bytes):
 *     magic "LFSENC1\0" (8) | version (1) | log2(N) (1) | r (1) | p (1)
 *     salt (16) | wrapIv (12) | wrapTag (16) | wrappedKey (32)
 *     noncePrefix (7) | chunkSize (4, uint32 BE)
 *   body: chunks of AES-256-GCM(ciphertext (<= chunkSize) | tag (16))
 *     nonce = noncePrefix (7) | chunk index (4, uint32 BE) | last flag (1)
 *     AAD   = header
 * The last flag (STREAM construction) means truncating or reordering chunks is detected.
 */

const MAGIC = Buffer.from('LFSENC1\0', 'latin1');
const FORMAT_VERSION = 1;
const HEADER_SIZE = 8 + 4 + 16 + 12 + 16 + 32 + 7 + 4; // 99
const TAG_SIZE = 16;
const CHUNK_SIZE = 64 * 1024;
// NOTE: 32 MiB memory, ~100ms per derivation. Runs once per upload batch and per unlock attempt.
const FILE_KDF = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** @typedef {{N: number, r: number, p: number, salt: Buffer}} KdfParams */

/**
 * @typedef FileHeader
 * @property {Buffer} raw
 * @property {KdfParams} kdf
 * @property {Buffer} wrapIv
 * @property {Buffer} wrapTag
 * @property {Buffer} wrappedKey
 * @property {Buffer} noncePrefix
 * @property {number} chunkSize
 */

/** @returns {KdfParams} */
function newKdfParams() {
    return Object.assign({ salt: crypto.randomBytes(16) }, FILE_KDF);
}

/**
 * @param {string} password
 * @param {KdfParams} kdf
 * @returns {Promise<Buffer>} -- key encryption key
 */
function deriveKek(password, kdf) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password.normalize('NFC'), kdf.salt, 32, {
            N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM
        }, (error, key) => error ? reject(error) : resolve(key));
    });
}

/** @param {KdfParams} kdf */
function kdfBytes(kdf) {
    return Buffer.from([FORMAT_VERSION, Math.log2(kdf.N), kdf.r, kdf.p]);
}

/**
 * @param {Buffer} kek
 * @param {KdfParams} kdf
 * @returns {{header: Buffer, fileKey: Buffer}}
 */
function buildHeader(kek, kdf) {
    const fileKey = crypto.randomBytes(32);
    const wrapIv = crypto.randomBytes(12);
    const wrapAad = Buffer.concat([MAGIC, kdfBytes(kdf), kdf.salt]);
    const cipher = crypto.createCipheriv('aes-256-gcm', kek, wrapIv);
    cipher.setAAD(wrapAad);
    const wrappedKey = Buffer.concat([cipher.update(fileKey), cipher.final()]);
    const chunkSize = Buffer.alloc(4);
    chunkSize.writeUInt32BE(CHUNK_SIZE);
    const header = Buffer.concat([
        wrapAad, wrapIv, cipher.getAuthTag(), wrappedKey, crypto.randomBytes(7), chunkSize
    ]);
    return { header, fileKey };
}

/**
 * @param {Buffer} raw
 * @returns {FileHeader|null}
 */
function parseHeader(raw) {
    if (raw.length < HEADER_SIZE || !raw.subarray(0, 8).equals(MAGIC)) return null;
    if (raw[8] !== FORMAT_VERSION) return null;
    let offset = 12;
    const take = (length) => raw.subarray(offset, (offset += length));
    const header = {
        raw: Buffer.from(raw.subarray(0, HEADER_SIZE)),
        kdf: { N: 2 ** raw[9], r: raw[10], p: raw[11], salt: take(16) },
        wrapIv: take(12),
        wrapTag: take(16),
        wrappedKey: take(32),
        noncePrefix: take(7),
        chunkSize: take(4).readUInt32BE(0)
    };
    // NOTE: Refuse absurd parameters from a tampered header (memory/CPU exhaustion).
    if (header.kdf.N > 2 ** 20 || header.kdf.r > 16 || header.kdf.p > 4) return null;
    if (header.chunkSize < 1024 || header.chunkSize > 16 * 1024 * 1024) return null;
    return header;
}

/**
 * @param {string} filePath
 * @returns {Promise<{header: FileHeader|null, size: number}>}
 */
function readHeader(filePath) {
    return new Promise((resolve, reject) => {
        fs.open(filePath, 'r', (error, fd) => {
            if (error) return reject(error);
            const raw = Buffer.alloc(HEADER_SIZE);
            fs.read(fd, raw, 0, HEADER_SIZE, 0, (error, bytesRead) => {
                fs.fstat(fd, (statError, stats) => {
                    fs.close(fd, () => {});
                    if (error || statError) return reject(error || statError);
                    resolve({
                        header: bytesRead === HEADER_SIZE ? parseHeader(raw) : null,
                        size: stats.size
                    });
                });
            });
        });
    });
}

/**
 * @param {FileHeader} header
 * @param {Buffer} kek
 * @returns {Buffer|null} -- file key, null if the password was wrong
 */
function unwrapFileKey(header, kek) {
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', kek, header.wrapIv);
        decipher.setAAD(Buffer.concat([MAGIC, kdfBytes(header.kdf), header.kdf.salt]));
        decipher.setAuthTag(header.wrapTag);
        return Buffer.concat([decipher.update(header.wrappedKey), decipher.final()]);
    } catch (error) {
        return null;
    }
}

/**
 * @param {Buffer} noncePrefix
 * @param {number} index
 * @param {boolean} isLast
 */
function chunkNonce(noncePrefix, index, isLast) {
    const nonce = Buffer.alloc(12);
    noncePrefix.copy(nonce, 0);
    nonce.writeUInt32BE(index, 7);
    nonce[11] = isLast ? 1 : 0;
    return nonce;
}

/**
 * @param {number} fileSize -- encrypted file size
 * @param {FileHeader} header
 * @returns {number} -- original file size
 */
function plaintextSize(fileSize, header) {
    const bodySize = fileSize - HEADER_SIZE;
    const chunkCount = Math.max(1, Math.ceil(bodySize / (header.chunkSize + TAG_SIZE)));
    return bodySize - chunkCount * TAG_SIZE;
}

/**
 * Encrypts a stream: emits the header, then authenticated chunks.
 * @param {Buffer} kek
 * @param {KdfParams} kdf
 */
function createEncryptStream(kek, kdf) {
    const { header, fileKey } = buildHeader(kek, kdf);
    const noncePrefix = header.subarray(HEADER_SIZE - 11, HEADER_SIZE - 4);
    let pending = Buffer.alloc(0);
    let index = 0;
    const sealChunk = (plaintext, isLast) => {
        const cipher = crypto.createCipheriv('aes-256-gcm', fileKey, chunkNonce(noncePrefix, index++, isLast));
        cipher.setAAD(header);
        return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    };
    let headerSent = false;
    return new Transform({
        transform(chunk, _encoding, callback) {
            if (!headerSent) {
                headerSent = true;
                this.push(header);
            }
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            // NOTE: Keeps at least one byte back, the last chunk must be sealed as last.
            while (pending.length > CHUNK_SIZE) {
                this.push(sealChunk(pending.subarray(0, CHUNK_SIZE), false));
                pending = pending.subarray(CHUNK_SIZE);
            }
            callback();
        },
        flush(callback) {
            if (!headerSent) this.push(header);
            this.push(sealChunk(pending, true));
            fileKey.fill(0);
            callback();
        }
    });
}

/**
 * Decrypts the body of an encrypted file (without the header).
 * Errors on any tampering, truncation or wrong key.
 * @param {FileHeader} header
 * @param {Buffer} fileKey
 */
function createDecryptStream(header, fileKey) {
    const sealedSize = header.chunkSize + TAG_SIZE;
    let pending = Buffer.alloc(0);
    let index = 0;
    const openChunk = (sealed, isLast) => {
        const decipher = crypto.createDecipheriv('aes-256-gcm', fileKey, chunkNonce(header.noncePrefix, index++, isLast));
        decipher.setAAD(header.raw);
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_SIZE));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_SIZE)), decipher.final()]);
    };
    return new Transform({
        transform(chunk, _encoding, callback) {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            try {
                while (pending.length > sealedSize) {
                    this.push(openChunk(pending.subarray(0, sealedSize), false));
                    pending = pending.subarray(sealedSize);
                }
            } catch (error) {
                return callback(new Error("Encrypted file is corrupted"));
            }
            callback();
        },
        flush(callback) {
            try {
                if (pending.length < TAG_SIZE) throw new Error("truncated");
                this.push(openChunk(pending, true));
            } catch (error) {
                return callback(new Error("Encrypted file is corrupted"));
            }
            callback();
        }
    });
}

/**
 * Writable that encrypts into `filePath`. The key derivation may still be
 * running, writes wait for it. Ends only after the file is fully on disk.
 * @param {string} filePath
 * @param {Promise<Buffer>} kekPromise
 * @param {KdfParams} kdf
 */
function createEncryptingFileSink(filePath, kekPromise, kdf) {
    /** @type {Transform|null} */
    let encrypt = null;
    /** @type {fs.WriteStream|null} */
    let out = null;
    const ready = kekPromise.then((kek) => {
        encrypt = createEncryptStream(kek, kdf);
        out = fs.createWriteStream(filePath, { mode: 0o600 });
        encrypt.pipe(out);
        out.on('error', (error) => sink.destroy(error));
    });
    const sink = new Writable({
        write(chunk, _encoding, callback) {
            ready.then(() => {
                if (encrypt.write(chunk)) callback();
                else encrypt.once('drain', () => callback());
            }, callback);
        },
        final(callback) {
            ready.then(() => {
                out.once('close', () => callback());
                encrypt.end();
            }, callback);
        },
        destroy(error, callback) {
            if (encrypt) encrypt.destroy();
            if (out) out.destroy();
            callback(error);
        }
    });
    return sink;
}

/** A writable that throws everything away, for uploads that will be rejected. */
function createDiscardSink() {
    return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

/**
 * Limits how many key derivations run at once, so password attempts can't
 * exhaust the CPU or memory.
 */
class KdfQueue {
    /** @param {number} concurrency */
    constructor(concurrency) {
        this.concurrency = concurrency;
        this.running = 0;
        /** @type {Array<function(): void>} */
        this.waiting = [];
    }
    /**
     * @template T
     * @param {function(): Promise<T>} task
     * @returns {Promise<T>}
     */
    run(task) {
        return new Promise((resolve, reject) => {
            const start = () => {
                this.running++;
                task().then(resolve, reject).finally(() => {
                    this.running--;
                    const next = this.waiting.shift();
                    if (next) next();
                });
            };
            if (this.running < this.concurrency) start();
            else this.waiting.push(start);
        });
    }
}

// NOTE: Crockford base32, no I/L/O/U so it's easy to read out and type.
const PASSWORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** @returns {string} -- 80 random bits like "K7QM-2XRP-9TVD-4HWN" */
function generatePassword() {
    const bytes = crypto.randomBytes(16);
    let out = "";
    for (let i = 0; i < 16; i++) {
        out += PASSWORD_ALPHABET[bytes[i] & 31];
        if (i % 4 == 3 && i < 15) out += "-";
    }
    return out;
}

module.exports = {
    HEADER_SIZE,
    newKdfParams,
    deriveKek,
    readHeader,
    unwrapFileKey,
    plaintextSize,
    createEncryptStream,
    createDecryptStream,
    createEncryptingFileSink,
    createDiscardSink,
    KdfQueue,
    generatePassword
};
