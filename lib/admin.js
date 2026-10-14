// @ts-check
"use strict";

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { StateStore, WrongSecretError } = require('./state-store');

/*
 * Admin panel, only for the machine the server runs on.
 *
 * Guards on every request:
 *  - the TCP peer is loopback (never X-Forwarded-For, a local reverse proxy would make everyone loopback)
 *  - the Host header is localhost, so a DNS rebinding page can't reach it through the browser
 *  - mutating requests need a same-origin Origin header and a JSON body (no simple cross-site forms)
 *  - after login: an HttpOnly SameSite=Strict session cookie plus a CSRF token header
 */

const SESSION_COOKIE = 'lfs_admin';
const SESSION_IDLE_MS = 30 * 60 * 1000;

/** @type {Object<string, "boolean"|[number, number]>} -- integer ranges are inclusive */
const CONFIG_SCHEMA = {
    allowDeletion: "boolean",
    multiUpload: "boolean",
    folderUpload: "boolean",
    trustProxy: "boolean",
    maxFileSize: [1, Number.MAX_SAFE_INTEGER],
    maxAutoDeleteMinutes: [1, 10 * 365 * 24 * 60],
    ownershipTtlMinutes: [1, 7 * 24 * 60],
    banThreshold: [1, 1000],
    banHours: [1, 365 * 24],
    minPasswordLength: [4, 128]
};

/** @param {string|undefined} address */
function isLoopback(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** @param {string|undefined} host */
function isLocalHost(host) {
    return typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

/** @param {string|undefined} cookieHeader */
function readCookie(cookieHeader, name) {
    if (typeof cookieHeader !== 'string') return null;
    for (const part of cookieHeader.split(';')) {
        const [key, ...value] = part.trim().split('=');
        if (key === name) return value.join('=');
    }
    return null;
}

/**
 * @param {object} options
 * @param {StateStore} options.stateStore
 * @param {import('./attempt-limiter').AttemptLimiter} options.attemptLimiter
 * @param {any} options.policyStore
 * @param {string} options.filesFolderPath
 * @param {function(string): (string|null)} options.resolveInsideFilesFolder
 * @param {boolean} options.debugPrintPasswords
 * @param {function(): ({fingerprint: string, selfSigned: boolean}|null)} options.getTlsInfo
 */
module.exports = function createAdminRouter(options) {
    const { stateStore, attemptLimiter, policyStore, resolveInsideFilesFolder } = options;
    const router = express.Router();

    /** @type {Map<string, {csrf: string, lastSeen: number}>} */
    const sessions = new Map();

    router.use(function (req, res, next) {
        if (!isLoopback(req.socket.remoteAddress) || req.headers['x-forwarded-for'] != null || !isLocalHost(req.headers.host)) {
            res.status(403).type('text').send("The admin panel is only available on the server machine, at http(s)://localhost:<port>/admin");
            return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; form-action 'none'");
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = req.headers.origin;
            const expectedOrigins = [`http://${req.headers.host}`, `https://${req.headers.host}`];
            if (typeof origin !== 'string' || !expectedOrigins.includes(origin) || !req.is('application/json')) {
                res.status(403).json({ error: "Cross-origin admin requests are not allowed." });
                return;
            }
        }
        next();
    });

    router.use(express.static(path.join(__dirname, '..', 'admin'), { index: 'index.html' }));
    router.use(express.json({ limit: '16kb' }));

    function currentSession(req) {
        const id = readCookie(req.headers.cookie, SESSION_COOKIE);
        if (id == null) return null;
        const session = sessions.get(id);
        if (session == null) return null;
        if (Date.now() - session.lastSeen > SESSION_IDLE_MS || !stateStore.isUnlocked()) {
            sessions.delete(id);
            return null;
        }
        session.lastSeen = Date.now();
        return session;
    }

    function startSession(req, res) {
        const id = crypto.randomBytes(32).toString('base64url');
        const session = { csrf: crypto.randomBytes(32).toString('base64url'), lastSeen: Date.now() };
        sessions.set(id, session);
        const secure = req.secure ? '; Secure' : '';
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/admin${secure}`);
        return session;
    }

    /** Requires a logged in session and its CSRF token on mutating requests. */
    function requireSession(req, res, next) {
        const session = currentSession(req);
        if (session == null) {
            res.status(401).json({ error: "Not logged in." });
            return;
        }
        if (req.method !== 'GET') {
            const token = req.headers['x-csrf-token'];
            if (typeof token !== 'string' || token.length !== session.csrf.length ||
                !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf))) {
                res.status(403).json({ error: "Invalid CSRF token." });
                return;
            }
        }
        next();
    }

    function statusOf(req) {
        const session = currentSession(req);
        return {
            state: !stateStore.exists() ? "new" : (stateStore.isUnlocked() ? "unlocked" : "locked"),
            loggedIn: session != null,
            csrf: session ? session.csrf : null,
            minSecretLength: StateStore.MIN_SECRET_LENGTH,
            debugPrintPasswords: options.debugPrintPasswords,
            tls: options.getTlsInfo()
        };
    }

    router.get('/api/status', function (req, res) {
        res.json(statusOf(req));
    });

    // First run: creates the encrypted state.
    router.post('/api/setup', async function (req, res, next) {
        try {
            const secret = req.body && req.body.secret;
            if (stateStore.exists()) {
                res.status(409).json({ error: "Already set up." });
                return;
            }
            const invalid = StateStore.validateNewSecret(secret);
            if (invalid) {
                res.status(400).json({ error: invalid });
                return;
            }
            await stateStore.create(secret);
            console.log("Server set up and unlocked from the admin panel.");
            const session = startSession(req, res);
            res.json(Object.assign(statusOf(req), { loggedIn: true, csrf: session.csrf }));
        } catch (error) {
            next(error);
        }
    });

    // Unlocks a locked server, or logs in to an unlocked one.
    router.post('/api/login', async function (req, res, next) {
        try {
            const secret = req.body && req.body.secret;
            if (typeof secret !== 'string' || !stateStore.exists()) {
                res.status(400).json({ error: "Missing secret key." });
                return;
            }
            if (stateStore.isUnlocked()) {
                if (!(await stateStore.verifySecret(secret))) throw new WrongSecretError();
            } else {
                await stateStore.unlock(secret);
                console.log("Server unlocked from the admin panel.");
            }
            const session = startSession(req, res);
            res.json(Object.assign(statusOf(req), { loggedIn: true, csrf: session.csrf }));
        } catch (error) {
            if (error instanceof WrongSecretError) {
                res.status(401).json({ error: "Wrong secret key." });
            } else {
                next(error);
            }
        }
    });

    router.post('/api/logout', requireSession, function (req, res) {
        sessions.delete(readCookie(req.headers.cookie, SESSION_COOKIE));
        res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`);
        res.json({ ok: true });
    });

    router.get('/api/config', requireSession, function (req, res) {
        res.json({ config: stateStore.data.config, schema: CONFIG_SCHEMA });
    });

    router.put('/api/config', requireSession, function (req, res) {
        const changes = req.body || {};
        const config = stateStore.data.config;
        const errors = [];
        Object.keys(changes).forEach((key) => {
            const rule = CONFIG_SCHEMA[key];
            const value = changes[key];
            if (rule == null) {
                errors.push(`Unknown setting ${key}`);
            } else if (rule === "boolean" ? typeof value !== 'boolean' :
                (!Number.isInteger(value) || value < rule[0] || value > rule[1])) {
                errors.push(rule === "boolean" ? `${key} must be true or false` : `${key} must be a whole number from ${rule[0]} to ${rule[1]}`);
            }
        });
        if (errors.length > 0) {
            res.status(400).json({ error: errors.join(". ") });
            return;
        }
        Object.assign(config, changes);
        stateStore.markDirty();
        res.json({ config });
    });

    router.get('/api/bans', requireSession, function (req, res) {
        res.json({ bans: attemptLimiter.list(), threshold: stateStore.data.config.banThreshold });
    });

    router.post('/api/bans/clear', requireSession, function (req, res) {
        const ip = req.body && req.body.ip;
        if (typeof ip !== 'string') {
            res.sendStatus(400);
            return;
        }
        attemptLimiter.unban(ip);
        res.json({ ok: true });
    });

    router.get('/api/files', requireSession, function (req, res) {
        res.json({
            files: policyStore.entries().map(([filePath, policy]) => ({
                path: filePath,
                deleteAt: policy.deleteAt,
                maxDownloads: policy.maxDownloads,
                downloadCount: policy.downloadCount,
                protected: policy.protected === true
            }))
        });
    });

    router.post('/api/files/delete', requireSession, function (req, res) {
        const filePath = req.body && req.body.path;
        if (typeof filePath !== 'string' || resolveInsideFilesFolder(path.normalize(filePath)) == null) {
            res.sendStatus(400);
            return;
        }
        policyStore.deleteFile(path.normalize(filePath));
        res.json({ ok: true });
    });

    router.post('/api/rotate', requireSession, async function (req, res, next) {
        try {
            const { current, next: newSecret } = req.body || {};
            if (typeof current !== 'string' || typeof newSecret !== 'string') {
                res.sendStatus(400);
                return;
            }
            await stateStore.rotate(current, newSecret);
            console.log("Secret key changed from the admin panel.");
            res.json({ ok: true });
        } catch (error) {
            if (error instanceof WrongSecretError) {
                res.status(401).json({ error: "The current secret key is wrong." });
            } else if (error instanceof Error && /secret key must be/.test(error.message)) {
                res.status(400).json({ error: error.message });
            } else {
                next(error);
            }
        }
    });

    return router;
};
