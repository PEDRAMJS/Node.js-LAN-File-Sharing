// @ts-check
"use strict";

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/*
 * HTTPS certificate: either the operator's own, or a self-signed one generated
 * once and kept in the data folder. Browsers will warn about a self-signed
 * certificate, users can compare the fingerprint the server prints.
 */

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {Array<string>} options.addresses -- LAN IPs to put in the certificate
 * @param {string} [options.certPath] -- own certificate (PEM)
 * @param {string} [options.keyPath] -- own private key (PEM)
 * @returns {{key: string, cert: string, fingerprint: string, selfSigned: boolean}}
 */
function loadOrCreateTls(options) {
    if (options.certPath || options.keyPath) {
        if (!options.certPath || !options.keyPath) throw new Error("--https-cert and --https-key go together");
        const cert = fs.readFileSync(options.certPath, 'utf8');
        return {
            key: fs.readFileSync(options.keyPath, 'utf8'),
            cert,
            fingerprint: new crypto.X509Certificate(cert).fingerprint256,
            selfSigned: false
        };
    }

    const tlsDir = path.join(options.dataDir, 'tls');
    const certPath = path.join(tlsDir, 'cert.pem');
    const keyPath = path.join(tlsDir, 'key.pem');
    const namesPath = path.join(tlsDir, 'names.json');
    const names = ['localhost', '127.0.0.1', ...options.addresses].sort();

    let existingNames = null;
    try {
        existingNames = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
    } catch (error) {
        // NOTE: No certificate yet.
    }
    const certExpired = () => {
        try {
            return new Date(new crypto.X509Certificate(fs.readFileSync(certPath)).validTo) <= new Date();
        } catch (error) {
            return true;
        }
    };
    // NOTE: Regenerated when the machine's IPs change, otherwise browsers reject the name.
    if (JSON.stringify(existingNames) !== JSON.stringify(names) || certExpired()) {
        const selfsigned = require('selfsigned');
        const generated = selfsigned.generate([{ name: 'commonName', value: 'LAN File Sharing' }], {
            keySize: 2048,
            days: 825,
            algorithm: 'sha256',
            extensions: [
                { name: 'basicConstraints', cA: false },
                { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
                { name: 'extKeyUsage', serverAuth: true },
                {
                    name: 'subjectAltName',
                    altNames: names.map((name) => /^[\d.]+$/.test(name) ? { type: 7, ip: name } : { type: 2, value: name })
                }
            ]
        });
        fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(keyPath, generated.private, { mode: 0o600 });
        fs.writeFileSync(certPath, generated.cert, { mode: 0o644 });
        fs.writeFileSync(namesPath, JSON.stringify(names));
        console.log("Generated a new self-signed HTTPS certificate.");
    }
    const cert = fs.readFileSync(certPath, 'utf8');
    return {
        key: fs.readFileSync(keyPath, 'utf8'),
        cert,
        fingerprint: new crypto.X509Certificate(cert).fingerprint256,
        selfSigned: true
    };
}

module.exports = { loadOrCreateTls };
