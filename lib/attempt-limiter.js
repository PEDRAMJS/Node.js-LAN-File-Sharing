// @ts-check
"use strict";

/*
 * Failed password attempts per IP, persisted in the encrypted state.
 * NOTE: A success never resets the count, otherwise anyone could reset it by
 * unlocking their own protected file between guesses.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

class AttemptLimiter {
    /**
     * @param {import('./state-store').StateStore} stateStore
     */
    constructor(stateStore) {
        this.stateStore = stateStore;
        /** @type {Map<string, {count: number, lastAt: number}>} -- failures per file from any IP, in memory */
        this.fileFailures = new Map();
        const cleanupInterval = setInterval(() => this._cleanup(), 10 * 60 * 1000);
        if (cleanupInterval.unref) cleanupInterval.unref();
    }

    get _config() { return this.stateStore.data.config; }
    get _bans() { return this.stateStore.data.bans; }

    _entry(ip) {
        const now = Date.now();
        let entry = this._bans[ip];
        if (entry == null) return { failures: [], bannedUntil: null };
        entry.failures = entry.failures.filter((at) => at > now - WINDOW_MS);
        if (entry.bannedUntil != null && entry.bannedUntil <= now) {
            // NOTE: A served ban starts the count from zero.
            entry.bannedUntil = null;
            entry.failures = [];
        }
        return entry;
    }

    /**
     * @param {string} ip
     * @returns {{banned: boolean, bannedUntil: number|null, attemptsLeft: number}}
     */
    status(ip) {
        const entry = this._entry(ip);
        const banned = entry.bannedUntil != null;
        return {
            banned,
            bannedUntil: entry.bannedUntil,
            attemptsLeft: banned ? 0 : Math.max(0, this._config.banThreshold - entry.failures.length)
        };
    }

    /**
     * @param {string} ip
     * @param {string} filePath
     */
    recordFailure(ip, filePath) {
        const now = Date.now();
        const entry = this._entry(ip);
        entry.failures.push(now);
        if (entry.failures.length >= this._config.banThreshold) {
            entry.bannedUntil = now + this._config.banHours * 60 * 60 * 1000;
        }
        this._bans[ip] = entry;
        this.stateStore.markDirty();

        const fileEntry = this.fileFailures.get(filePath) || { count: 0, lastAt: 0 };
        fileEntry.count += 1;
        fileEntry.lastAt = now;
        this.fileFailures.set(filePath, fileEntry);
        return this.status(ip);
    }

    /**
     * Extra wait before checking a password for a file that keeps getting
     * wrong guesses from anyone (e.g. an attacker rotating IPs).
     * @param {string} filePath
     * @returns {number} -- ms
     */
    fileDelayMs(filePath) {
        const fileEntry = this.fileFailures.get(filePath);
        if (fileEntry == null || Date.now() - fileEntry.lastAt > 10 * 60 * 1000) return 0;
        if (fileEntry.count < 5) return 0;
        return Math.min(5000, 250 * 2 ** (fileEntry.count - 5));
    }

    /** @param {string} ip */
    unban(ip) {
        delete this._bans[ip];
        this.stateStore.markDirty();
    }

    /** @returns {Array<{ip: string, failures: number, bannedUntil: number|null}>} */
    list() {
        return Object.keys(this._bans).map((ip) => {
            const entry = this._entry(ip);
            return { ip, failures: entry.failures.length, bannedUntil: entry.bannedUntil };
        }).filter((row) => row.failures > 0 || row.bannedUntil != null);
    }

    _cleanup() {
        const now = Date.now();
        this.fileFailures.forEach((entry, filePath) => {
            if (now - entry.lastAt > 10 * 60 * 1000) this.fileFailures.delete(filePath);
        });
        if (!this.stateStore.isUnlocked()) return;
        let changed = false;
        Object.keys(this._bans).forEach((ip) => {
            const entry = this._entry(ip);
            if (entry.failures.length == 0 && entry.bannedUntil == null) {
                delete this._bans[ip];
                changed = true;
            }
        });
        if (changed) this.stateStore.markDirty();
    }
}

module.exports = { AttemptLimiter };
