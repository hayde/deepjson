// Tests for reloadAccessData(), behind POST /admin/reload-access.
//
// Background: access.json was read exactly once, in the constructor. Adding a user
// or changing a permission meant restarting the whole database, and a JSON typo
// combined with Restart=always put it into a crash loop until someone fixed the
// file by hand. The reload has one hard requirement: a file that does not parse or
// does not validate must leave the running server exactly as it was.
//
// Run with: node --test test/accessReload.test.js

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const validAccess = () => ({
    users: {
        alice: { id: 'alice', email: 'a@example.com', password: 'scrypt:aa:bb', groups: ['editors'] }
    },
    groups: {
        editors: { rules: [{ regex: '^public\\..*', crudx: '11110' }] }
    }
});

async function harness(initial = validAccess()) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-access-'));
    const accessPath = path.join(dir, 'access.json');
    await fsp.writeFile(accessPath, JSON.stringify(initial, null, 2));

    const srv = Object.create(DeepJSONServer.prototype);
    srv.config = { access_file: accessPath };
    srv.accessData = JSON.parse(JSON.stringify(initial));
    return { srv, accessPath };
}

const write = (p, value) => fsp.writeFile(p, typeof value === 'string' ? value : JSON.stringify(value, null, 2));

describe('reloadAccessData - happy path', () => {
    test('picks up a newly added user without a restart', async () => {
        const { srv, accessPath } = await harness();
        assert.strictEqual(srv.accessData.users.bob, undefined);

        const next = validAccess();
        next.users.bob = { id: 'bob', email: 'b@example.com', password: 'scrypt:cc:dd', groups: ['editors'] };
        await write(accessPath, next);

        const result = await srv.reloadAccessData();

        assert.strictEqual(srv.accessData.users.bob.id, 'bob');
        assert.strictEqual(result.users, 2);
        assert.strictEqual(result.usersBefore, 1);
        assert.strictEqual(result.groups, 1);
    });

    test('picks up a changed permission rule', async () => {
        const { srv, accessPath } = await harness();
        // The starting rule is "11110": CRUD granted, eXecute denied.
        assert.strictEqual(srv.checkPermissions({ id: 'alice' }, 'public.doc', 'X'), false);

        const next = validAccess();
        next.groups.editors.rules = [{ regex: '^public\\..*', crudx: '11111' }];
        await write(accessPath, next);

        await srv.reloadAccessData();

        assert.strictEqual(srv.checkPermissions({ id: 'alice' }, 'public.doc', 'X'), true,
            'the new rule should apply immediately');
    });

    test('a new group origin reaches the CORS whitelist with no further wiring', async () => {
        const { srv, accessPath } = await harness();
        // Empty whitelist means open, so start from a file that already restricts.
        const restricted = validAccess();
        restricted.groups.editors.allowed_origins = ['https://one.example.com'];
        await write(accessPath, restricted);
        await srv.reloadAccessData();
        assert.strictEqual(srv.isOriginAllowed('https://two.example.com'), false);

        restricted.groups.editors.allowed_origins.push('https://two.example.com');
        await write(accessPath, restricted);
        await srv.reloadAccessData();

        assert.strictEqual(srv.isOriginAllowed('https://two.example.com'), true);
    });
});

describe('reloadAccessData - rejection keeps the server serving', () => {
    test('malformed JSON is refused and the previous data stays in effect', async () => {
        const { srv, accessPath } = await harness();
        const before = srv.accessData;

        await write(accessPath, '{ "users": { "alice": ');

        await assert.rejects(
            () => srv.reloadAccessData(),
            (err) => {
                assert.strictEqual(err.code, 'ACCESS_RELOAD_FAILED');
                assert.match(err.message, /Could not reload access_file/);
                return true;
            }
        );

        assert.strictEqual(srv.accessData, before, 'accessData must be untouched');
        assert.strictEqual(srv.accessData.users.alice.id, 'alice');
    });

    test('a file that parses but does not validate is refused, with the problems listed', async () => {
        const { srv, accessPath } = await harness();
        const before = srv.accessData;

        const broken = validAccess();
        broken.users.alice.groups = ['does-not-exist'];
        await write(accessPath, broken);

        await assert.rejects(
            () => srv.reloadAccessData(),
            (err) => {
                assert.strictEqual(err.code, 'ACCESS_RELOAD_FAILED');
                assert.ok(Array.isArray(err.problems));
                assert.ok(
                    err.problems.some(p => /unknown group "does-not-exist"/.test(p)),
                    `expected the specific problem, got ${JSON.stringify(err.problems)}`
                );
                return true;
            }
        );

        assert.strictEqual(srv.accessData, before);
        assert.deepStrictEqual(srv.accessData.users.alice.groups, ['editors']);
    });

    test('a plaintext password is refused, same as at startup', async () => {
        const { srv, accessPath } = await harness();

        const broken = validAccess();
        broken.users.alice.password = 'hunter2';
        await write(accessPath, broken);

        await assert.rejects(() => srv.reloadAccessData(), /Refusing to reload access_file/);
        assert.strictEqual(srv.accessData.users.alice.password, 'scrypt:aa:bb');
    });

    test('an uncompilable rule regex is refused', async () => {
        const { srv, accessPath } = await harness();

        const broken = validAccess();
        broken.groups.editors.rules = [{ regex: '^public\\.[', crudx: '11110' }];
        await write(accessPath, broken);

        await assert.rejects(() => srv.reloadAccessData(), { code: 'ACCESS_RELOAD_FAILED' });
    });

    test('a missing file is refused rather than emptying the access data', async () => {
        const { srv, accessPath } = await harness();
        await fsp.rm(accessPath);

        await assert.rejects(() => srv.reloadAccessData(), { code: 'ACCESS_RELOAD_FAILED' });
        assert.strictEqual(srv.accessData.users.alice.id, 'alice');
    });
});

describe('collectAccessProblems', () => {
    test('reports problems without throwing, unlike validateConfig', () => {
        const srv = Object.create(DeepJSONServer.prototype);
        const { errors } = srv.collectAccessProblems({ users: {}, groups: 'not-an-object' });

        assert.ok(errors.some(e => /"groups" is missing or not an object/.test(e)));
    });

    test('an empty user list is a warning, not an error', () => {
        const srv = Object.create(DeepJSONServer.prototype);
        const { errors, warnings } = srv.collectAccessProblems({ users: {}, groups: {} });

        assert.deepStrictEqual(errors, []);
        assert.ok(warnings.some(w => /"users" is empty/.test(w)));
    });

    test('a valid file produces no problems at all', () => {
        const srv = Object.create(DeepJSONServer.prototype);
        const { errors, warnings } = srv.collectAccessProblems(validAccess());

        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(warnings, []);
    });
});
