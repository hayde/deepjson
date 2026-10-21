// Password hashes for access.json, in the form "scrypt:<salt>:<hash>".
//
// One module for the server and bin/hash-password.js, so the generator and the
// validator cannot drift apart.

const crypto = require('crypto');

const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Every hash this project has produced has a 32-hex salt and a 128-hex hash.
// Salts of 16 to 128 hex characters are accepted; the hash length is exact.
const HASH_PATTERN = new RegExp(`^scrypt:[0-9a-fA-F]{16,128}:[0-9a-fA-F]{${KEY_BYTES * 2}}$`);
const HASH_FORMAT = `scrypt:<salt>:<${KEY_BYTES * 2} hex characters>`;

function isPasswordHash(value) {
    return typeof value === 'string' && HASH_PATTERN.test(value);
}

function hashPassword(password) {
    const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
    const hash = crypto.scryptSync(password, salt, KEY_BYTES).toString('hex');
    return `scrypt:${salt}:${hash}`;
}

// A malformed hash never verifies. It used to: one that decoded to zero bytes,
// like the "scrypt:REPLACE:REPLACE" placeholder, accepted any password, and a
// very short one could be guessed in a few hundred tries.
function verifyPassword(password, stored) {
    if (typeof password !== 'string' || !isPasswordHash(stored)) return false;
    const [, salt, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

module.exports = { isPasswordHash, hashPassword, verifyPassword, HASH_FORMAT };
