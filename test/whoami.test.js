// Tests for GET /version and GET /whoami.
//
// Both sit behind authMiddleware, so they also serve as a login check and carry a
// renewed token. The interesting part here is /whoami's `rules`: they are returned
// for display only, because checkPermissions() resolves them last-match-wins, which
// is not what a client reimplementing them would assume. The last test pins that
// difference down so nobody "simplifies" the contract later.
//
// Run with: node --test test/whoami.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

function makeRes() {
    return {
        body: null,
        statusCode: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

const accessData = () => ({
    users: {
        alice: { id: 'alice', email: 'alice@example.com', password: 'scrypt:aa:bb', groups: ['editors'] },
        root: { id: 'root', email: 'root@example.com', password: 'scrypt:cc:dd', groups: ['superadmin'] }
    },
    groups: {
        editors: { rules: [{ regex: '.*', crudx: '11110' }] },
        superadmin: { rules: [{ regex: '.*', crudx: '11111' }] }
    }
});

function harness(data = accessData()) {
    const h = Object.create(DeepJSONServer.prototype);
    h.accessData = data;
    return h;
}

function whoami(userId, query = {}, data = accessData()) {
    const h = harness(data);
    const req = { user: data.users[userId], query };
    const res = makeRes();
    DeepJSONServer.prototype.handleWhoami.call(h, req, res);
    return res.body;
}

describe('GET /version', () => {
    test('returns the version from package.json', () => {
        const res = makeRes();
        DeepJSONServer.prototype.handleVersion.call(harness(), {}, res);
        assert.strictEqual(res.body.version, require('../package.json').version);
    });

    test('carries nothing else, so it stays cheap as a heartbeat', () => {
        const res = makeRes();
        DeepJSONServer.prototype.handleVersion.call(harness(), {}, res);
        assert.deepStrictEqual(Object.keys(res.body), ['version']);
    });
});

describe('GET /whoami', () => {
    test('reports identity, groups and the admin flag', () => {
        const body = whoami('alice');
        assert.deepStrictEqual(body.user, { id: 'alice', email: 'alice@example.com' });
        assert.deepStrictEqual(body.groups, ['editors']);
        assert.strictEqual(body.isAdmin, false);
        assert.strictEqual(body.authenticated, true);
    });

    test('an admin is marked as one', () => {
        assert.strictEqual(whoami('root').isAdmin, true);
    });

    test('never leaks the stored password hash', () => {
        // The record in accessData carries `password`; the payload is built field
        // by field precisely so that spreading can never hand it to a client.
        for (const id of ['alice', 'root']) {
            const serialized = JSON.stringify(whoami(id, { keys: 'x' }));
            assert.ok(!/scrypt/.test(serialized), `password hash leaked for ${id}`);
            assert.ok(!/password/i.test(serialized), `password field leaked for ${id}`);
        }
    });

    test('lists the rules in evaluation order with their owning group', () => {
        const body = whoami('alice');
        assert.deepStrictEqual(body.rules, [{ group: 'editors', regex: '.*', crudx: '11110' }]);
        assert.strictEqual(body.rulesAreAdvisory, true);
    });

    test('?keys= resolves effective permissions through checkPermissions()', () => {
        const body = whoami('alice', { keys: 'reports.q3, secret.foo ' });
        // crudx 11110 -> everything but execute, and whitespace around keys is tolerated.
        assert.deepStrictEqual(body.permissions['reports.q3'], { C: true, R: true, U: true, D: true, X: false });
        assert.deepStrictEqual(body.permissions['secret.foo'], { C: true, R: true, U: true, D: true, X: false });
    });

    test('permissions are omitted entirely when no keys are asked for', () => {
        assert.strictEqual('permissions' in whoami('alice'), false);
    });

    test('the advisory warning is real: naive rule evaluation disagrees with the server', () => {
        // Two rules: allow everything, then revoke reads on secret.*. The server
        // resolves last-match-wins, so reading secret.foo is denied. A client doing
        // the usual "any matching rule grants it" would conclude the opposite.
        const data = accessData();
        data.groups.editors.rules = [
            { regex: '.*', crudx: '11110' },
            { regex: '^secret\\..*', crudx: '00000' }
        ];

        const body = whoami('alice', { keys: 'secret.foo,public.foo' }, data);
        assert.strictEqual(body.permissions['secret.foo'].R, false, 'server must deny the revoked key');
        assert.strictEqual(body.permissions['public.foo'].R, true);

        const naive = body.rules.some(r => new RegExp(r.regex).test('secret.foo') && r.crudx[1] === '1');
        assert.strictEqual(naive, true, 'naive evaluation grants it - which is exactly the trap');
        assert.notStrictEqual(naive, body.permissions['secret.foo'].R,
            'if these ever agree, the last-match-wins semantics changed and the docs need updating');
    });
});
