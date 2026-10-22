// Password hashes in access.json must be well-formed to verify (issue #26).
//
// A hash that decoded to zero bytes, such as the "scrypt:REPLACE:REPLACE"
// placeholder in examples/access.json.example, used to accept any password, and a
// very short one could be brute-forced in a few hundred tries. Covers the hash
// check, login, startup and reload validation, and the shipped example file.
//
// Run with: node --test test/passwordHash.test.js

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = fs.promises;
const DeepJSONServer = require('../server');
const { isPasswordHash, hashPassword, verifyPassword } = require('../lib/password');

const SALT = 'a1'.repeat(16);   // 32 hex characters, as the tools produce
const HASH = 'b2'.repeat(64);   // 128 hex characters

// Malformed hashes that used to verify, or nearly so.
const MALFORMED = {
    'the example placeholder': 'scrypt:REPLACE:REPLACE',
    'an empty hash': `scrypt:${SALT}:`,
    'an empty salt and hash': 'scrypt::',
    'a single non-hex character': 'scrypt:salt:z',
    'a 1-byte hash': 'scrypt:aa:bb',
    'valid hex followed by junk': `scrypt:${SALT}:abab${'Z'.repeat(124)}`,
    'a hash one character short': `scrypt:${SALT}:${HASH.slice(1)}`,
    'a hash one byte short': `scrypt:${SALT}:${HASH.slice(2)}`,
    'a hash one byte long': `scrypt:${SALT}:${HASH}ab`,
    'a salt shorter than 16 hex characters': `scrypt:${'a'.repeat(15)}:${HASH}`,
    'a salt longer than 128 hex characters': `scrypt:${'a'.repeat(129)}:${HASH}`,
    'a non-hex salt': `scrypt:${'g'.repeat(32)}:${HASH}`,
    'an extra field': `scrypt:${SALT}:${HASH}:x`,
    'an upper-case prefix': `SCRYPT:${SALT}:${HASH}`,
    'a trailing space': `scrypt:${SALT}:${HASH} `,
    'a trailing newline': `scrypt:${SALT}:${HASH}\n`
};

describe('password hash format', () => {
    test('hashes from hashPassword() and bin/hash-password.js are valid and verify', () => {
        const fromServer = hashPassword('correct horse');
        const fromTool = execFileSync('node', [path.join(__dirname, '..', 'bin', 'hash-password.js'), 'correct horse']).toString().trim();
        for (const stored of [fromServer, fromTool]) {
            assert.ok(isPasswordHash(stored), stored);
            assert.strictEqual(verifyPassword('correct horse', stored), true);
            assert.strictEqual(verifyPassword('wrong horse', stored), false);
        }
    });

    for (const [what, stored] of Object.entries(MALFORMED)) {
        test(`${what} is not a valid hash and accepts no password`, () => {
            assert.strictEqual(isPasswordHash(stored), false);
            for (const password of ['', 'anything', 'REPLACE', 'guess1']) {
                assert.strictEqual(verifyPassword(password, stored), false);
            }
        });
    }

    test('the 1-byte hash can no longer be brute-forced', () => {
        for (let i = 0; i < 1000; i++) {
            assert.strictEqual(verifyPassword(`guess${i}`, 'scrypt:aa:bb'), false);
        }
    });

    test('an upper-case hex hash still verifies', () => {
        const stored = hashPassword('pw');
        const [prefix, salt, hash] = stored.split(':');
        assert.strictEqual(verifyPassword('pw', `${prefix}:${salt}:${hash.toUpperCase()}`), true);
    });

    test('non-string passwords and stored values never verify', () => {
        const stored = hashPassword('pw');
        for (const password of [undefined, null, 1, {}, ['pw']]) {
            assert.strictEqual(verifyPassword(password, stored), false);
        }
        for (const value of [undefined, null, 1, {}, [stored]]) {
            assert.strictEqual(verifyPassword('pw', value), false);
        }
    });
});

describe('authenticateUser', () => {
    const users = {
        admin: { id: 'admin', password: hashPassword('right'), groups: ['superadmin'] },
        placeholder: { id: 'placeholder', password: 'scrypt:REPLACE:REPLACE', groups: ['superadmin'] },
        device: { id: 'device', password: null, groups: ['superadmin'] }
    };
    const login = (username, password) => DeepJSONServer.prototype.authenticateUser.call(
        { accessData: { users }, verifyPassword: DeepJSONServer.prototype.verifyPassword }, username, password);

    test('a real user with the right password logs in', () => {
        assert.strictEqual(login('admin', 'right').id, 'admin');
    });

    test('a placeholder hash refuses every password, even if validation was skipped', () => {
        for (const password of ['', 'anything', 'REPLACE']) {
            assert.throws(() => login('placeholder', password), /Invalid credentials/);
        }
    });

    test('a user with "password": null cannot log in with a password', () => {
        assert.throws(() => login('device', ''), /Invalid credentials/);
        assert.throws(() => login('device', 'null'), /Invalid credentials/);
    });

    test('built-in object names and non-string usernames are not users', () => {
        for (const username of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', ['admin'], { toString: () => 'admin' }]) {
            assert.throws(() => login(username, 'right'), /Invalid credentials/);
        }
    });
});

describe('startup and reload validation', () => {
    const groups = { superadmin: { rules: [{ regex: '.*', crudx: '11111' }] } };
    const problems = (password) => DeepJSONServer.prototype.collectAccessProblems.call({},
        { users: { admin: { id: 'admin', password, groups: ['superadmin'] } }, groups });

    test('a real hash produces no problem', () => {
        const { errors, warnings } = problems(hashPassword('pw'));
        assert.deepStrictEqual([errors, warnings.filter((w) => /password/.test(w))], [[], []]);
    });

    test('every malformed hash is an error that names the user and the fix, not the value', () => {
        for (const stored of Object.values(MALFORMED)) {
            const { errors } = problems(stored);
            assert.strictEqual(errors.length, 1, stored);
            assert.match(errors[0], /user "admin" has a password that is not a scrypt hash/);
            assert.match(errors[0], /node bin\/hash-password\.js/);
            assert.match(errors[0], /"password": null/);
            assert.ok(!errors[0].includes(stored.trim()) || stored.trim() === '', 'the stored value is not echoed');
        }
    });

    test('"password": null is accepted silently: password login is disabled', () => {
        const { errors, warnings } = problems(null);
        assert.deepStrictEqual([errors, warnings], [[], []]);
    });

    test('a non-string password is a warning, not an error', () => {
        for (const value of [1234, true, {}, []]) {
            const { errors, warnings } = problems(value);
            assert.deepStrictEqual(errors, []);
            assert.match(warnings.join('\n'), /not a string, so password login is disabled/);
        }
    });

    test('a missing password is an error that offers "password": null', () => {
        const { errors } = problems(undefined);
        assert.match(errors[0], /has no password; .*"password": null/);
    });

    test('the shipped example access.json is refused until its placeholders are replaced', () => {
        const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'access.json.example'), 'utf8'));
        const { errors } = DeepJSONServer.prototype.collectAccessProblems.call({}, example);
        const passwordErrors = errors.filter((e) => /not a scrypt hash/.test(e));
        assert.strictEqual(passwordErrors.length, Object.keys(example.users).length);
    });

    test('reload-access refuses a placeholder hash and keeps the previous access data', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-password-reload-'));
        try {
            const file = path.join(dir, 'access.json');
            const good = { users: { admin: { id: 'admin', password: hashPassword('pw'), groups: ['superadmin'] } }, groups };
            const server = Object.assign(Object.create(DeepJSONServer.prototype), { config: { access_file: file }, accessData: good });
            await fsp.writeFile(file, JSON.stringify({ ...good, users: { admin: { ...good.users.admin, password: 'scrypt:REPLACE:REPLACE' } } }));
            await assert.rejects(server.reloadAccessData(), (err) => err.code === 'ACCESS_RELOAD_FAILED' && /not a scrypt hash/.test(err.problems.join()));
            assert.strictEqual(server.accessData, good);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });
});

describe('login over HTTP', () => {
    let server, base;

    before(async () => {
        const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-password-http-'));
        server = Object.create(DeepJSONServer.prototype);
        Object.assign(server, {
            config: { data_root: dataRoot, port: 0, jwt_secret: 'password-test-secret-0123456789abcdef0123456789abcdef', index_depth: 2 },
            // Not validated on purpose: login itself must refuse a placeholder hash.
            accessData: {
                users: {
                    admin: { id: 'admin', password: hashPassword('right'), groups: ['superadmin'] },
                    placeholder: { id: 'placeholder', password: 'scrypt:REPLACE:REPLACE', groups: ['superadmin'] }
                },
                groups: { superadmin: { rules: [{ regex: '.*', crudx: '11111' }] } }
            },
            index: new Map(), modificationCounter: 0, _keyLocks: new Map(), _dataRoot: dataRoot
        });
        await server.createDirectories();
        await server.loadIndex();
        server.setupServer();
        await once(server.server, 'listening');
        base = `http://127.0.0.1:${server.server.address().port}`;
    });

    after(async () => {
        server.server.closeAllConnections();
        await new Promise((resolve) => server.io.close(() => resolve()));
        await fsp.rm(server._dataRoot, { recursive: true, force: true });
    });

    const login = (username, password) => fetch(`${base}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
    });

    test('the placeholder user gets 401 for any password', async () => {
        for (const password of ['anything', '', 'REPLACE']) {
            assert.strictEqual((await login('placeholder', password)).status, 401);
        }
    });

    test('a real user still logs in and gets a token', async () => {
        const res = await login('admin', 'right');
        assert.strictEqual(res.status, 200);
        assert.ok((await res.json()).token);
    });

    test('built-in object names are refused as usernames', async () => {
        assert.strictEqual((await login('__proto__', 'x')).status, 401);
        assert.strictEqual((await login('constructor', 'x')).status, 401);
    });
});
