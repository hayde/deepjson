// x-override-existing: an explicit "false" must not overwrite an existing key.
//
// The server used to check only that the header was present, so the JS connector's
// `X-Override-Existing: false` - sent on every upload without `overwrite` - replaced
// the existing file. Runs the real Express stack on an ephemeral port.
//
// Run with: node --test test/overrideExisting.test.js

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { once } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs').promises;
const jwt = require('jsonwebtoken');
const DeepJSONServer = require('../server');

const SECRET = 'override-existing-test-secret-0123456789abcdef0123456789';

describe('x-override-existing', () => {
    let srv;
    let dj;
    const JSON_TYPE = { 'Content-Type': 'application/json' };

    const send = (method, key, body, headers = {}) => fetch(`${srv.base}/keys/${key}`, {
        method, body, headers: { ...srv.auth, ...headers }
    });
    const upload = (key, contents, headers = {}) => {
        const form = new FormData();
        form.append('file', new Blob([contents], { type: 'application/pdf' }), 'doc.pdf');
        return send('POST', key, form, headers);
    };
    const value = async (key) => (await (await send('GET', key)).json());

    before(async () => {
        const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-override-'));
        dj = Object.create(DeepJSONServer.prototype);
        Object.assign(dj, {
            config: { data_root: dataRoot, port: 0, jwt_secret: SECRET, index_depth: 2 },
            accessData: {
                users: { admin: { id: 'admin', password: null, groups: ['superadmin'] } },
                groups: { superadmin: { rules: [{ regex: '.*', crudx: '11111' }] } }
            },
            index: new Map(),
            modificationCounter: 0,
            _keyLocks: new Map()
        });
        dj.accessData.users.admin.password = dj.hashPassword('secret');
        await dj.createDirectories();
        await dj.loadIndex();
        dj.setupServer();
        await once(dj.server, 'listening');
        const port = dj.server.address().port;
        srv = {
            base: `http://127.0.0.1:${port}`,
            auth: { Authorization: `Bearer ${jwt.sign({ id: 'admin', groups: ['superadmin'] }, SECRET, { expiresIn: '1h' })}` },
            async close() {
                dj.server.closeAllConnections();
                await new Promise((resolve) => dj.io.close(() => resolve()));
                await fsp.rm(dataRoot, { recursive: true, force: true });
            }
        };
    });

    after(async () => { await srv.close(); });

    test('header values are read as yes or no', () => {
        const asks = (v) => dj._hasOverwriteExisting({ headers: v === undefined ? {} : { 'x-override-existing': v } });
        for (const no of [undefined, '', '  ', 'false', 'FALSE', ' False ', '0', 'no', 'off']) {
            assert.strictEqual(asks(no), false, `${JSON.stringify(no)} must mean no`);
        }
        for (const yes of ['true', 'TRUE', '1', 'yes', 'on', 'anything']) {
            assert.strictEqual(asks(yes), true, `${JSON.stringify(yes)} must mean yes`);
        }
    });

    test('POST with "false" on an existing key is refused and leaves it unchanged', async () => {
        assert.strictEqual((await send('POST', 'ov.json', JSON.stringify({ n: 1 }), JSON_TYPE)).status, 201);
        const res = await send('POST', 'ov.json', JSON.stringify({ n: 2 }), { ...JSON_TYPE, 'X-Override-Existing': 'false' });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /Key already exists/);
        assert.deepStrictEqual(await value('ov.json'), { n: 1 });
    });

    test('POST with "true" on an existing key overwrites it', async () => {
        await send('POST', 'ov.json2', JSON.stringify({ n: 1 }), JSON_TYPE);
        const res = await send('POST', 'ov.json2', JSON.stringify({ n: 2 }), { ...JSON_TYPE, 'X-Override-Existing': 'true' });
        assert.strictEqual(res.status, 201);
        assert.deepStrictEqual(await value('ov.json2'), { n: 2 });
    });

    test('a file upload with "false" on an existing key is refused and keeps the old file', async () => {
        assert.strictEqual((await upload('ov.file', 'first')).status, 201);
        const hashBefore = dj.index.get('ov.file') && (await dj.readKeyData(null, 'ov.file'))._meta.hash;

        const res = await upload('ov.file', 'second, different content', { 'X-Override-Existing': 'false' });
        assert.strictEqual(res.status, 400);
        assert.strictEqual((await dj.readKeyData(null, 'ov.file'))._meta.hash, hashBefore);
    });

    test('a file upload with "true" on an existing key replaces the file', async () => {
        await upload('ov.file2', 'first');
        const hashBefore = (await dj.readKeyData(null, 'ov.file2'))._meta.hash;

        const res = await upload('ov.file2', 'second, different content', { 'X-Override-Existing': 'true' });
        assert.strictEqual(res.status, 201);
        assert.notStrictEqual((await dj.readKeyData(null, 'ov.file2'))._meta.hash, hashBefore);
    });
});
