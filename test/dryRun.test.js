// Dry run: X-DeepJSON-Dry-Run reports what a write would do and changes nothing.
// Runs the real Express stack on an ephemeral port.
//
// Run with: node --test test/dryRun.test.js

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { once } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs').promises;
const jwt = require('jsonwebtoken');
const DeepJSONServer = require('../server');

const SECRET = 'dry-run-test-secret-0123456789abcdef0123456789abcdef';

describe('dry run', () => {
    let srv;
    let dj;
    const DRY = { 'X-DeepJSON-Dry-Run': 'true' };
    const JSON_TYPE = { 'Content-Type': 'application/json' };
    const TEXT_TYPE = { 'Content-Type': 'text/plain' };

    const send = (method, key, body, headers = {}) => fetch(`${srv.base}/keys/${key}`, {
        method, body, headers: { ...srv.auth, ...headers }
    });
    const script = (code, body = {}) => `javascript: ${code} javascript! ${JSON.stringify(body)}`;
    const keyFile = (key) => { const { dir, file } = dj.getKeyPath(key); return path.join(dir, file); };
    const snapshot = async (key) => ({
        file: await fsp.readFile(keyFile(key)),
        mod: dj.modificationCounter,
        indexed: dj.index.has(key)
    });

    before(async () => {
        const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-dry-run-'));
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

    test('PUT with a script shows before and after and leaves the file byte-identical', async () => {
        await send('POST', 'dr.put', JSON.stringify({ n: 1 }), JSON_TYPE);
        const was = await snapshot('dr.put');

        const res = await send('PUT', 'dr.put', script('data.n += body.add; response = { sum: data.n };', { add: 4 }), { ...TEXT_TYPE, ...DRY });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.headers.get('x-deepjson-dry-run'), 'true');
        assert.deepStrictEqual(await res.json(), {
            dryRun: true, status: 200, exists: true, before: { n: 1 }, after: { n: 5 }, response: { sum: 5 }
        });

        const now = await snapshot('dr.put');
        assert.ok(was.file.equals(now.file));
        assert.strictEqual(now.mod, was.mod);
    });

    test('header values 1 and TRUE are accepted, other values are not', async () => {
        for (const [value, dry] of [['1', true], ['TRUE', true], ['false', false], ['yes', false]]) {
            const key = `dr.values.${value}`;
            const res = await send('POST', key, JSON.stringify(1), { ...JSON_TYPE, 'X-DeepJSON-Dry-Run': value });
            assert.strictEqual(res.status, dry ? 200 : 201);
            assert.strictEqual(res.headers.get('x-deepjson-dry-run'), dry ? 'true' : null);
        }
    });

    test('POST on a new key reports 201 and the key does not exist afterwards', async () => {
        const mod = dj.modificationCounter;
        const res = await send('POST', 'dr.new', JSON.stringify({ a: 1 }), { ...JSON_TYPE, ...DRY });
        assert.deepStrictEqual(await res.json(), {
            dryRun: true, status: 201, exists: false, before: null, after: { a: 1 }, response: { ok: 'successfull' }
        });
        assert.strictEqual((await send('GET', 'dr.new')).status, 404);
        assert.strictEqual(dj.index.has('dr.new'), false);
        assert.strictEqual(dj.modificationCounter, mod);
    });

    test('POST on an existing key keeps its 400', async () => {
        await send('POST', 'dr.dup', JSON.stringify(1), JSON_TYPE);
        const res = await send('POST', 'dr.dup', JSON.stringify(2), { ...JSON_TYPE, ...DRY });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.headers.get('x-deepjson-dry-run'), 'true');
    });

    test('POST with a generated key reports it without reserving it', async () => {
        const res = await send('POST', encodeURIComponent('dr.gen.*{type:inc}'), JSON.stringify(1), { ...JSON_TYPE, ...DRY });
        const out = await res.json();
        assert.strictEqual(out.status, 201);
        assert.deepStrictEqual(out.response, { ok: 'success', key: 'dr.gen.1' });
        assert.strictEqual(dj.index.has('dr.gen.1'), false);
        const real = await send('POST', encodeURIComponent('dr.gen.*{type:inc}'), JSON.stringify(1), JSON_TYPE);
        assert.strictEqual((await real.json()).key, 'dr.gen.1');
    });

    test('DELETE reports 204 and the key still exists', async () => {
        await send('POST', 'dr.del', JSON.stringify({ keep: true }), JSON_TYPE);
        const was = await snapshot('dr.del');
        const res = await send('DELETE', 'dr.del', undefined, DRY);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), {
            dryRun: true, status: 204, exists: true, before: { keep: true }, after: null, response: null
        });
        const now = await snapshot('dr.del');
        assert.ok(was.file.equals(now.file));
        assert.deepStrictEqual(now, { ...was, file: now.file });
        assert.strictEqual((await send('GET', 'dr.del')).status, 200);
    });

    test('a failing If-Match still gives 412', async () => {
        await send('POST', 'dr.etag', JSON.stringify(1), JSON_TYPE);
        const res = await send('PUT', 'dr.etag', JSON.stringify(2), { ...JSON_TYPE, ...DRY, 'If-Match': '"99"' });
        assert.strictEqual(res.status, 412);
        assert.strictEqual(res.headers.get('x-deepjson-dry-run'), 'true');
    });

    test('a script abort keeps its status', async () => {
        await send('POST', 'dr.abort', JSON.stringify(1), JSON_TYPE);
        const res = await send('PUT', 'dr.abort', script('abort = { status: 409, error: "nope" };'), { ...TEXT_TYPE, ...DRY });
        assert.strictEqual(res.status, 409);
        assert.strictEqual((await res.json()).dryRun, undefined);
    });

    test('a script error still returns SCRIPT_ERROR', async () => {
        await send('POST', 'dr.err', JSON.stringify(1), JSON_TYPE);
        const res = await send('PUT', 'dr.err', script('data = nothing.here;'), { ...TEXT_TYPE, ...DRY });
        assert.strictEqual(res.status, 500);
        assert.strictEqual((await res.json()).code, 'SCRIPT_ERROR');
    });

    test('x-method-override is respected', async () => {
        await send('POST', 'dr.override', JSON.stringify(1), JSON_TYPE);
        const res = await send('POST', 'dr.override', undefined, { ...DRY, 'x-method-override': 'DELETE' });
        assert.strictEqual((await res.json()).status, 204);
        assert.strictEqual((await send('GET', 'dr.override')).status, 200);
    });

    test('a multipart upload is refused', async () => {
        const form = new FormData();
        form.append('file', new Blob(['hello']), 'a.txt');
        const res = await send('POST', 'dr.file', form, DRY);
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /not supported/);
        assert.strictEqual(dj.index.has('dr.file'), false);
    });

    test('GET with the header is a normal GET', async () => {
        await send('POST', 'dr.get', JSON.stringify({ g: 1 }), JSON_TYPE);
        const res = await send('GET', 'dr.get', undefined, DRY);
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(await res.json(), { g: 1 });
        assert.strictEqual(res.headers.get('x-deepjson-dry-run'), null);
    });
});
