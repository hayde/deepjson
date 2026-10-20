// Key names must not be able to forge entries in the index log (dj.index).
//
// A key holding a line break or "|" used to be written into the log as is, so a
// user could plant a fake line - for example a DELETE for another user's key -
// that took effect at the next restart. Covers the line format, the restart
// round-trip, compatibility with existing index files, and key-name validation.
//
// Run with: node --test test/indexLogInjection.test.js

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { once } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const jwt = require('jsonwebtoken');
const DeepJSONServer = require('../server');

const SECRET = 'index-log-injection-test-secret-0123456789abcdef0123456789';

const ACCESS = {
    users: {
        admin: { id: 'admin', groups: ['superadmin'] },
        alice: { id: 'alice', groups: ['alices'] },
        bob: { id: 'bob', groups: ['bobs'] }
    },
    groups: {
        superadmin: { rules: [{ regex: '.*', crudx: '11111' }] },
        alices: { rules: [{ regex: '^alice\\.', crudx: '11111' }] },
        bobs: { rules: [{ regex: '^bob\\.', crudx: '11111' }] }
    }
};

function makeServer(dataRoot) {
    const server = Object.create(DeepJSONServer.prototype);
    Object.assign(server, {
        config: { data_root: dataRoot, port: 0, jwt_secret: SECRET, index_depth: 2 },
        accessData: ACCESS,
        index: new Map(),
        modificationCounter: 0,
        _keyLocks: new Map()
    });
    return server;
}

// A fresh instance over the same data_root, as after a restart.
async function restart(dataRoot) {
    const server = makeServer(dataRoot);
    await server.loadIndex();
    return server;
}

const indexFile = (dataRoot) => path.join(dataRoot, 'index', 'dj.index');
const token = (id) => `Bearer ${jwt.sign({ id }, SECRET, { expiresIn: '1h' })}`;
// writeKeyData() reads res.locals.fileUpload, so direct calls need a minimal response.
const RES = { locals: {} };
const ENTRY = { hash: 'h'.repeat(64), created: '2026-01-01T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z', modCount: 7 };

describe('index line format', () => {
    const server = makeServer('/unused');

    test('an ordinary key is written exactly as before', () => {
        assert.strictEqual(server.formatIndexLine('app.doc-1', ENTRY, 'POST', 'alice'),
            `app.doc-1|${ENTRY.hash}|${ENTRY.created}|${ENTRY.modified}|7|POST|alice`);
        assert.strictEqual(server.formatIndexLine('app.doc-1', ENTRY),
            `app.doc-1|${ENTRY.hash}|${ENTRY.created}|${ENTRY.modified}|7`);
    });

    test('a key that could forge a line is written as one JSON line that round-trips', () => {
        for (const key of ['a\nb.x|0|0|0|0|DELETE', 'a|b', 'a\r\nb', '{"v":2,"k":"x"}', '{plain']) {
            const line = server.formatIndexLine(key, ENTRY, 'POST', 'alice');
            assert.ok(!line.includes('\n') && !line.includes('\r'), `${JSON.stringify(key)} stays on one line`);
            const parsed = server.parseIndexLine(line);
            assert.strictEqual(parsed.key, key);
            assert.strictEqual(parsed.operation, 'POST');
            assert.strictEqual(parsed.modCount, 7);
        }
    });

    test('a "|" in a user id keeps the pipe form, readable by the old parser', () => {
        const line = server.formatIndexLine('app.doc', ENTRY, 'DELETE', 'auth0|5f7c8e');
        assert.strictEqual(line, `app.doc|${ENTRY.hash}|${ENTRY.created}|${ENTRY.modified}|7|DELETE|auth0|5f7c8e`);
        const [key, , , , , operation] = line.split('|'); // the parser that shipped before
        assert.deepStrictEqual([key, operation], ['app.doc', 'DELETE']);
    });

    test('a user id that could forge a line is written as JSON too', () => {
        const line = server.formatIndexLine('app.doc', ENTRY, 'POST', 'eve\nvictim|0|0|0|0|DELETE');
        assert.ok(!line.includes('\n'));
        assert.strictEqual(server.parseIndexLine(line).key, 'app.doc');
    });

    test('legacy lines parse as before, including a key that starts with "{"', () => {
        assert.deepStrictEqual(server.parseIndexLine('k.1|abc|c|m|5|DELETE|bob'),
            { key: 'k.1', hash: 'abc', created: 'c', modified: 'm', modCount: '5', operation: 'DELETE' });
        assert.strictEqual(server.parseIndexLine('{legacy}|abc|c|m|5').key, '{legacy}');
    });

    test('missing fields are written exactly as the old template did', () => {
        assert.strictEqual(server.formatIndexLine('k', { hash: undefined, created: null, modified: 'm', modCount: 0 }),
            'k|undefined|null|m|0');
    });

    test('a non-string key or field can never break a line', () => {
        const line = server.formatIndexLine(['x\nbob.important|0|0|0|0|DELETE'], ENTRY);
        assert.ok(!line.includes('\n'));
        assert.strictEqual(server.parseIndexLine(line), null, 'not a usable key, so not loaded');
        const tampered = server.formatIndexLine('app.doc', { ...ENTRY, created: 'x\nbob.important|0|0|0|0|DELETE' });
        assert.ok(!tampered.includes('\n'));
        assert.strictEqual(server.parseIndexLine(tampered).key, 'app.doc');
    });

    test('a key with a lone surrogate round-trips in the JSON form', () => {
        const key = 'app.s\ud800';
        const line = server.formatIndexLine(key, ENTRY);
        assert.ok(line.startsWith('{"v":2,'));
        assert.strictEqual(server.parseIndexLine(line).key, key);
    });

    test('a legacy key that happens to begin with the JSON prefix still loads', () => {
        assert.strictEqual(server.parseIndexLine(`{"v":2,"k":"z"}|${'a'.repeat(64)}|c|m|7`).key, '{"v":2,"k":"z"}');
    });

    test('a cut-off JSON line is skipped, even when its key contains "|"', () => {
        assert.strictEqual(server.parseIndexLine('{"v":2,"k":"admin.cut-off|x","h":"aa'), null);
        assert.strictEqual(server.parseIndexLine('{"v":2,"k":"a|b|c|d|e","h":"aa'), null);
    });

    test('a line too damaged to name its key is rejected, not turned into a key', () => {
        assert.strictEqual(server.parseIndexLine('alice.trunc'), null);
        assert.strictEqual(server.parseIndexLine('{"v":2,"k":"cut-off'), null);
    });
});

describe('restart and rotation keep every key intact', () => {
    let dataRoot;
    before(async () => { dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-index-inject-')); });
    after(async () => { await fsp.rm(dataRoot, { recursive: true, force: true }); });

    const req = { user: { id: 'alice' } };
    const forged = 'alice.x\nbob.important|0|0|0|0|DELETE';

    test('a forged DELETE inside a key name no longer deletes the other key', async () => {
        const server = makeServer(dataRoot);
        await server.createDirectories();
        await server.loadIndex();
        await server.writeKeyData(req, RES, 'bob.important', { value: 'precious' });
        await server.writeKeyData(req, RES, forged, { value: 'attack' });
        await server.writeKeyData(req, RES, 'alice.pipe|x|x|x|0|DELETE', { value: 'pipes' });

        const after = await restart(dataRoot);
        assert.ok(after.index.has('bob.important'), 'the targeted key survives the restart');
        assert.ok(after.index.has(forged), 'the odd key itself is kept, under its exact name');
        assert.ok(after.index.has('alice.pipe|x|x|x|0|DELETE'));
        assert.strictEqual(after.index.size, 3);
    });

    test('rotation rewrites the log in the safe form and loses nothing', async () => {
        const server = await restart(dataRoot);
        await server.performIndexRotation();
        const log = await fsp.readFile(indexFile(dataRoot), 'utf8');
        assert.strictEqual(log.trim().split('\n').length, 3, 'one line per key, no forged extra line');

        const after = await restart(dataRoot);
        assert.deepStrictEqual([...after.index.keys()].sort(), ['alice.pipe|x|x|x|0|DELETE', forged, 'bob.important'].sort());
    });

    test('rebuild-index ignores a data file whose _key is not a string', async () => {
        const server = await restart(dataRoot);
        const { dir, file } = server.getKeyPath('tampered');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, file), JSON.stringify({ _key: ['x\nbob.important|0|0|0|0|DELETE'], value: 1 }));
        await server.rebuildIndex();
        await server.performIndexRotation();
        const after = await restart(dataRoot);
        assert.strictEqual(after.index.size, 3);
        assert.ok(after.index.has('bob.important'));
        await fsp.unlink(path.join(dir, file));
    });

    test('an archive snapshot is written in the safe form as well', async () => {
        const server = await restart(dataRoot);
        await server.saveIndexSnapshot();
        const snapshot = await fsp.readFile(server.getIndexArchivePath(), 'utf8');
        assert.strictEqual(snapshot.trim().split('\n').length, 3);
    });

    test('an index written before this change loads exactly as before', async () => {
        const legacyRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-index-legacy-'));
        try {
            await fsp.mkdir(path.join(legacyRoot, 'index'), { recursive: true });
            await fsp.writeFile(indexFile(legacyRoot), [
                'a.one|h1|c1|m1|3',
                'a.two|h2|c2|m2|4|POST|alice',
                'a.gone|h3|c3|m3|5|POST|alice',
                'a.gone|h3|c3|m4|5|DELETE|alice',
                '{odd}|h4|c4|m4|6|PUT|bob',
                'truncated-without-pipe',
                ''
            ].join('\n'));
            const server = await restart(legacyRoot);
            assert.deepStrictEqual([...server.index.keys()].sort(), ['a.one', 'a.two', '{odd}']);
            assert.strictEqual(server.index.get('a.two').modCount, 4);
            // Same replay as the old loader: 3, 4, 5, DELETE (+1) = 6, then max(6, 6).
            assert.strictEqual(server.modificationCounter, 6);
        } finally {
            await fsp.rm(legacyRoot, { recursive: true, force: true });
        }
    });

    test('ordinary keys stay readable by the old parser, so a rollback is safe', async () => {
        const rollbackRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-index-rollback-'));
        try {
            const server = makeServer(rollbackRoot);
            await server.createDirectories();
            await server.loadIndex();
            for (const key of ['app.a', 'app.b-2', 'users.42.profile']) {
                await server.writeKeyData(req, RES, key, { value: 1 });
            }
            // The parser that shipped before this change.
            const oldKeys = (await fsp.readFile(indexFile(rollbackRoot), 'utf8'))
                .split('\n').filter((l) => l.trim()).map((l) => l.split('|')[0]);
            assert.deepStrictEqual(oldKeys.sort(), ['app.a', 'app.b-2', 'users.42.profile']);
        } finally {
            await fsp.rm(rollbackRoot, { recursive: true, force: true });
        }
    });
});

describe('key names over HTTP', () => {
    let dataRoot, server, base;

    const call = (method, urlPath, who, body, type = 'text/plain') => fetch(`${base}${urlPath}`, {
        method,
        headers: { Authorization: token(who), ...(body !== undefined ? { 'Content-Type': type } : {}) },
        body
    });

    before(async () => {
        dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-index-http-'));
        server = makeServer(dataRoot);
        await server.createDirectories();
        await server.loadIndex();
        server.setupServer();
        await once(server.server, 'listening');
        base = `http://127.0.0.1:${server.server.address().port}`;
    });

    after(async () => {
        server.server.closeAllConnections();
        await new Promise((resolve) => server.io.close(() => resolve()));
        await fsp.rm(dataRoot, { recursive: true, force: true });
    });

    test('the reported attack is refused and the victim key survives a restart', async () => {
        assert.strictEqual((await call('POST', '/keys/bob.important', 'bob', '{"v":1}')).status, 201);
        const attack = encodeURIComponent('alice.x\nbob.important|0|0|0|0|DELETE');
        const res = await call('POST', `/keys/${attack}`, 'alice', '{"v":2}');
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /control characters/);

        const after = await restart(dataRoot);
        assert.ok(after.index.has('bob.important'));
    });

    test('a key with "|" is accepted and survives a restart under its exact name', async () => {
        const key = 'alice.a|b';
        assert.strictEqual((await call('POST', `/keys/${encodeURIComponent(key)}`, 'alice', '{"v":3}')).status, 201);
        const after = await restart(dataRoot);
        assert.ok(after.index.has(key));
        assert.ok(!after.index.has('alice.a'), 'no truncated phantom key');
    });

    test('control characters are refused in wildcard patterns and in move targets', async () => {
        const pattern = encodeURIComponent('alice.\t*');
        assert.strictEqual((await call('POST', `/keys/${pattern}`, 'alice', '{"v":4}')).status, 400);

        await call('POST', '/keys/alice.src', 'alice', '{"v":5}');
        const move = (body) => call('POST', '/cmd/move', 'alice', JSON.stringify(body), 'application/json');
        assert.strictEqual((await move({ from: 'alice.src', to: 'alice.dst\nx' })).status, 400);
        assert.strictEqual((await move({ from: ['alice.src'], to: 'alice.dst' })).status, 400, 'non-string from');
        assert.strictEqual((await move({ from: 'alice.src', to: 42 })).status, 400, 'non-string to');
        const surrogate = await move({ from: 'alice.src', to: 'alice.s\ud800' });
        assert.strictEqual(surrogate.status, 400);
        assert.match((await surrogate.json()).error, /valid Unicode/);
    });

    test('a key that already exists with a control character stays reachable', async () => {
        const legacy = 'alice.tab\there';
        await server.writeKeyData({ user: { id: 'alice' } }, RES, legacy, { value: 'kept' });
        const res = await call('GET', `/keys/${encodeURIComponent(legacy)}`, 'alice');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(await res.json(), 'kept');

        // As a move target it is not refused either (the move itself may still
        // fail for JSON documents, a separate known bug).
        const move = await call('POST', '/cmd/move', 'alice', JSON.stringify({ from: 'alice.src', to: legacy }), 'application/json');
        const body = await move.json();
        assert.ok(!/control characters/.test(body.error || ''), 'existing key accepted as target');
    });
});
