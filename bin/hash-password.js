#!/usr/bin/env node
// Generates a scrypt password hash for use in access.json's users[*].password field.
// Usage: node bin/hash-password.js <password>

const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
    console.error('Usage: node bin/hash-password.js <password>');
    process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`scrypt:${salt}:${hash}`);
