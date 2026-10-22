#!/usr/bin/env node
// Generates a scrypt password hash for use in access.json's users[*].password field.
// Usage: node bin/hash-password.js <password>

const { hashPassword } = require('../lib/password');

const password = process.argv[2];
if (!password) {
    console.error('Usage: node bin/hash-password.js <password>');
    process.exit(1);
}

console.log(hashPassword(password));
