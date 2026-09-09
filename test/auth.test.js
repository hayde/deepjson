// Tests for password hashing (hashPassword/verifyPassword) and authenticateUser().
//
// Run with: node --test test/auth.test.js

const assert = require('node:assert');
const crypto = require('node:crypto');
const { test, describe } = require('node:test');
const jwt = require('jsonwebtoken');
const DeepJSONServer = require('../server');

// hashPassword/verifyPassword only use `crypto`, no this.config/this.accessData needed.
const hashPassword = (password) => DeepJSONServer.prototype.hashPassword.call({}, password);
const verifyPassword = (password, stored) => DeepJSONServer.prototype.verifyPassword.call({}, password, stored);

// authenticateUser() only reads this.accessData.users.
function authenticateUser(users, username, password) {
    const harness = { accessData: { users }, verifyPassword: DeepJSONServer.prototype.verifyPassword };
    return DeepJSONServer.prototype.authenticateUser.call(harness, username, password);
}

// checkUserList() is a pure function, no `this` state needed.
const checkUserList = (userList, user) => DeepJSONServer.prototype.checkUserList.call({}, userList, user);

describe('hashPassword / verifyPassword', () => {
    test('a hashed password verifies against its own plaintext', () => {
        const stored = hashPassword('correct horse battery staple');
        assert.strictEqual(verifyPassword('correct horse battery staple', stored), true);
    });

    test('the wrong password is rejected', () => {
        const stored = hashPassword('correct horse battery staple');
        assert.strictEqual(verifyPassword('wrong password', stored), false);
    });

    test('hashing the same password twice yields different hashes (random salt)', () => {
        const a = hashPassword('same-password');
        const b = hashPassword('same-password');
        assert.notStrictEqual(a, b);
        assert.strictEqual(verifyPassword('same-password', a), true);
        assert.strictEqual(verifyPassword('same-password', b), true);
    });

    test('stored value is never plaintext', () => {
        const stored = hashPassword('super-secret');
        assert.ok(!stored.includes('super-secret'));
        assert.match(stored, /^scrypt:[0-9a-f]+:[0-9a-f]+$/);
    });

    test('rejects malformed or legacy plaintext stored values instead of throwing', () => {
        assert.strictEqual(verifyPassword('CHANGE_ME', 'CHANGE_ME'), false);
        assert.strictEqual(verifyPassword('anything', ''), false);
        assert.strictEqual(verifyPassword('anything', undefined), false);
    });
});

describe('authenticateUser', () => {
    const users = {
        admin: { id: 'admin', password: hashPassword('correct-password'), groups: ['superadmin'] }
    };

    test('correct credentials return the user record', () => {
        const user = authenticateUser(users, 'admin', 'correct-password');
        assert.strictEqual(user.id, 'admin');
    });

    test('wrong password throws', () => {
        assert.throws(() => authenticateUser(users, 'admin', 'wrong-password'), /Invalid credentials/);
    });

    test('unknown username throws', () => {
        assert.throws(() => authenticateUser(users, 'nobody', 'whatever'), /Invalid credentials/);
    });
});

describe('checkUserList (HMAC device-auth whitelist)', () => {
    test('exact username match is allowed', () => {
        assert.strictEqual(checkUserList(['alice'], 'alice'), true);
    });

    test('non-matching username is rejected', () => {
        assert.strictEqual(checkUserList(['alice'], 'bob'), false);
    });

    test('regex wildcard patterns are supported, e.g. ".*"', () => {
        assert.strictEqual(checkUserList(['.*'], 'anyone'), true);
    });

    test('regex patterns are anchored (partial matches do not count)', () => {
        assert.strictEqual(checkUserList(['user[0-9]{1,2}'], 'user7'), true);
        assert.strictEqual(checkUserList(['user[0-9]{1,2}'], 'user789'), false);
        assert.strictEqual(checkUserList(['user[0-9]{1,2}'], 'not-user7'), false);
    });

    test('matching is case-insensitive', () => {
        assert.strictEqual(checkUserList(['Alice'], 'alice'), true);
    });

    test('an empty whitelist denies rather than throwing', () => {
        assert.strictEqual(checkUserList([], 'alice'), false);
    });
});

describe('handleDeviceAuth', () => {
    const SECRET = 'device-secret-value';
    const NOW = 1_700_000_000_000;

    function accessData(overrides = {}) {
        return {
            hmac_auth_settings: { hmac_window: 300 },
            devices: {
                'sensor-1': {
                    id: 'sensor-1',
                    secret: SECRET,
                    enabled: true,
                    user_list: ['alice', 'admin'],
                    ...overrides.device
                }
            },
            users: {
                alice: { id: 'alice', groups: ['device'] },
                admin: { id: 'admin', groups: ['superadmin'] },
                ...overrides.users
            }
        };
    }

    // Signs exactly the way handleDeviceAuth verifies: deviceId|user|method|path|timestamp
    function sign({ secret = SECRET, deviceId = 'sensor-1', user = 'alice', method = 'GET', path = '/keys/foo', timestamp = String(NOW) }) {
        return crypto.createHmac('sha256', secret).update(`${deviceId}|${user}|${method}|${path}|${timestamp}`).digest('hex');
    }

    function req({ deviceId = 'sensor-1', user = 'alice', timestamp = String(NOW), signature, method = 'GET', path = '/keys/foo' } = {}) {
        const sig = signature ?? sign({ deviceId, user, method, path, timestamp });
        return {
            headers: { 'x-device-auth': `${deviceId}:${timestamp}:${user}:${sig}` },
            method,
            path,
            ip: '127.0.0.1'
        };
    }

    async function run(data, requestObj, nowOverride = NOW) {
        const originalNow = Date.now;
        Date.now = () => nowOverride;
        try {
            const harness = {
                accessData: data,
                checkUserList: DeepJSONServer.prototype.checkUserList,
                checkIP: DeepJSONServer.prototype.checkIP
            };
            let nextCalled = false;
            const res = {
                statusCode: null,
                body: null,
                status(code) { this.statusCode = code; return this; },
                json(payload) { this.body = payload; return this; }
            };
            await DeepJSONServer.prototype.handleDeviceAuth.call(harness, requestObj, res, () => { nextCalled = true; });
            return { req: requestObj, res, nextCalled };
        } finally {
            Date.now = originalNow;
        }
    }

    test('a validly signed, fresh request is authenticated', async () => {
        const { nextCalled, req: r } = await run(accessData(), req());
        assert.strictEqual(nextCalled, true);
        assert.strictEqual(r.user.id, 'alice');
    });

    test('the signature does not verify if the "user" field is swapped after signing', async () => {
        // Regression test for the original bug: the signature used to be computed
        // from req.user/req.password (always undefined), so it never actually
        // depended on the `user` field in the header -- a signature issued for
        // "alice" could be replayed with user swapped to "admin" and still pass.
        const signatureForAlice = sign({ user: 'alice' });
        const { nextCalled, res } = await run(accessData(), req({ user: 'admin', signature: signatureForAlice }));
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
        assert.match(res.body.error, /Invalid signature/);
    });

    test('a stale timestamp is rejected with a clear error, not a crash', async () => {
        // Regression test: this path used to call the non-existent Date.toISOString()
        // (called on the Date class, not an instance) and throw a confusing TypeError
        // instead of the intended "Timestamp out of window" message.
        const staleTimestamp = String(NOW - 10 * 60 * 1000); // 10 minutes old, window is 5 minutes
        const { nextCalled, res } = await run(accessData(), req({ timestamp: staleTimestamp, user: 'alice' }));
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
        assert.match(res.body.error, /Timestamp out of window/);
    });

    test('a non-numeric timestamp is rejected instead of silently bypassing the freshness check', async () => {
        // Regression test: parseInt("not-a-number") is NaN, and Math.abs(now - NaN) > x
        // is always false, so a garbage timestamp used to sail through unchecked.
        const { nextCalled, res } = await run(accessData(), req({ timestamp: 'not-a-number', user: 'alice', signature: 'irrelevant' }));
        assert.strictEqual(nextCalled, false);
        assert.match(res.body.error, /Invalid timestamp/);
    });

    test('a wrong-length signature is rejected cleanly, not thrown as an internal error', async () => {
        const { nextCalled, res } = await run(accessData(), req({ signature: 'too-short' }));
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
        assert.match(res.body.error, /Invalid signature/);
    });

    test('a user outside the device whitelist is rejected', async () => {
        // "eve" is a real, known user -- just not in this device's user_list --
        // so this exercises the whitelist check specifically, not "unknown user".
        const data = accessData({ users: { eve: { id: 'eve', groups: [] } } });
        const { nextCalled, res } = await run(data, req({ user: 'eve', signature: sign({ user: 'eve' }) }));
        assert.strictEqual(nextCalled, false);
        assert.match(res.body.error, /whitelist/);
    });

    test('a disabled device is rejected', async () => {
        const data = accessData({ device: { id: 'sensor-1', secret: SECRET, enabled: false, user_list: ['alice'] } });
        const { nextCalled, res } = await run(data, req());
        assert.strictEqual(nextCalled, false);
        assert.match(res.body.error, /not registered/);
    });
});

describe('authMiddleware (sliding session)', () => {
    // Regression coverage for the X-Renewed-Token sliding-session mechanism:
    // every successful, authenticated request should re-issue a fresh token
    // with a renewed 1h expiry, since a JWT's own expiry can't be extended
    // in place once signed.
    const SECRET = 'jwt-secret-value';
    const users = {
        alice: { id: 'alice', groups: ['editors'] }
    };

    function makeRes() {
        return {
            headers: {},
            statusCode: null,
            body: null,
            set(name, value) { this.headers[name] = value; return this; },
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; }
        };
    }

    async function run(token) {
        const harness = { config: { jwt_secret: SECRET }, accessData: { users } };
        const req = { path: '/keys/foo', headers: { authorization: `Bearer ${token}` }, query: {} };
        const res = makeRes();
        let nextCalled = false;
        await DeepJSONServer.prototype.authMiddleware.call(harness, req, res, () => { nextCalled = true; });
        return { req, res, nextCalled };
    }

    test('a valid token is renewed and handed back via X-Renewed-Token', async () => {
        const token = jwt.sign({ id: 'alice', groups: ['editors'] }, SECRET, { expiresIn: '1h' });
        const { req, res, nextCalled } = await run(token);

        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.user.id, 'alice');

        const renewed = res.headers['X-Renewed-Token'];
        assert.ok(renewed, 'X-Renewed-Token header should be set');

        const decoded = jwt.verify(renewed, SECRET);
        assert.strictEqual(decoded.id, 'alice');
        assert.deepStrictEqual(decoded.groups, ['editors']);
        assert.ok(decoded.exp > Math.floor(Date.now() / 1000) + 3500, 'renewed token should carry a fresh ~1h expiry');
    });

    test('an invalid token is rejected and no renewed token is issued', async () => {
        const { res, nextCalled } = await run('not-a-real-token');
        assert.strictEqual(nextCalled, false);
        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.headers['X-Renewed-Token'], undefined);
    });

    test('a valid token for a since-deleted user is not renewed, but still lets the request through', async () => {
        // Mirrors existing behavior: authMiddleware doesn't reject an unknown
        // decoded.id today, it just leaves req.user undefined. The renewal
        // logic must not crash on that (no req.user.groups to read).
        const token = jwt.sign({ id: 'ghost', groups: ['editors'] }, SECRET, { expiresIn: '1h' });
        const { req, res, nextCalled } = await run(token);

        assert.strictEqual(nextCalled, true);
        assert.strictEqual(req.user, undefined);
        assert.strictEqual(res.headers['X-Renewed-Token'], undefined);
    });
});
