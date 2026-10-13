// How /keys/:key bodies are read, by Content-Type. Runs the real Express stack
// on an ephemeral port, since parser order and error handling only show up there.
//
// Run with: node --test test/contentType.test.js

const assert = require('node:assert');
const { test, describe, before, after } = require('node:test');
const { once } = require('node:events');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs').promises;
const jwt = require('jsonwebtoken');
const DeepJSONServer = require('../server');

const SECRET = 'content-type-test-secret-0123456789abcdef0123456789abcdef';

async function startServer(config = {}) {
    const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-content-type-'));
    const server = Object.create(DeepJSONServer.prototype);
    Object.assign(server, {
        config: { data_root: dataRoot, port: 0, jwt_secret: SECRET, index_depth: 2, ...config },
        accessData: {
            users: { admin: { id: 'admin', password: null, groups: ['superadmin'] } },
            groups: { superadmin: { rules: [{ regex: '.*', crudx: '11111' }] } }
        },
        index: new Map(),
        modificationCounter: 0,
        _keyLocks: new Map()
    });
    server.accessData.users.admin.password = server.hashPassword('secret');

    await server.createDirectories();
    await server.loadIndex();
    server.setupServer();
    await once(server.server, 'listening');

    const port = server.server.address().port;
    const token = jwt.sign({ id: 'admin', groups: ['superadmin'] }, SECRET, { expiresIn: '1h' });

    return {
        base: `http://127.0.0.1:${port}`,
        port,
        auth: { Authorization: `Bearer ${token}` },
        async close() {
            server.server.closeAllConnections();
            await new Promise((resolve) => server.io.close(() => resolve()));
            await fsp.rm(dataRoot, { recursive: true, force: true });
        }
    };
}

// Sends exact headers; fetch() can't omit Content-Type, chunk, or send a GET body.
function raw(srv, { method, path: urlPath, headers = {}, body }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: urlPath, headers: { ...srv.auth, ...headers } }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        });
        req.on('error', reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}

function multipartBody(boundary, parts) {
    return parts.map((part) => [
        `--${boundary}`,
        part.filename
            ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: text/plain`
            : `Content-Disposition: form-data; name="${part.name}"`,
        '',
        part.value
    ].join('\r\n')).join('\r\n') + `\r\n--${boundary}--\r\n`;
}

describe('Content-Type of /keys/:key bodies', () => {
    let srv;

    const send = (method, key, body, contentType, extraHeaders = {}) => fetch(`${srv.base}/keys/${encodeURIComponent(key)}`, {
        method,
        headers: { ...srv.auth, ...(contentType ? { 'Content-Type': contentType } : {}), ...extraHeaders },
        body
    });
    const read = async (key) => {
        const res = await fetch(`${srv.base}/keys/${encodeURIComponent(key)}`, { headers: srv.auth });
        return { status: res.status, value: res.status === 200 ? await res.json() : null };
    };

    before(async () => {
        srv = await startServer({
            payload_limit: '1kb',
            key_payload_limits: [
                { regex: '^small\\.', limit: '1kb' },
                { regex: '^big\\.', limit: '1mb' }
            ]
        });
    });

    after(async () => {
        await srv.close();
    });

    describe('application/json is stored exactly like text/plain', () => {
        test('POST creates the key and stores the document', async () => {
            const doc = { hello: 'world', nested: { list: [1, 2, 3] } };
            const res = await send('POST', 'json.post', JSON.stringify(doc), 'application/json');
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual(await res.json(), { ok: 'successfull' });
            assert.deepStrictEqual(await read('json.post'), { status: 200, value: doc });
        });

        test('PUT, GET and DELETE with a JSON body work like their text/plain equivalents', async () => {
            await send('POST', 'json.crud', JSON.stringify({ v: 1 }), 'application/json');

            const put = await send('PUT', 'json.crud', JSON.stringify({ v: 2 }), 'application/json');
            assert.strictEqual(put.status, 200);
            assert.deepStrictEqual((await read('json.crud')).value, { v: 2 });

            // A GET body without a script is ignored.
            const getBody = JSON.stringify({ ignored: true });
            const get = await raw(srv, { method: 'GET', path: '/keys/json.crud', headers: { 'Content-Type': 'application/json', 'Content-Length': String(getBody.length) }, body: getBody });
            assert.strictEqual(get.status, 200);
            assert.deepStrictEqual(JSON.parse(get.text), { v: 2 });

            const del = await send('DELETE', 'json.crud', JSON.stringify({ ignored: true }), 'application/json');
            assert.strictEqual(del.status, 204);
            assert.strictEqual((await read('json.crud')).status, 404);
        });

        test('every kind of top-level JSON value is stored, identically on both paths', async () => {
            const values = [{ a: 1 }, [1, 2, 3], [], {}, 42, 0, -1.5, 'text', '', true, false, null];
            for (const [i, value] of values.entries()) {
                const body = JSON.stringify(value);
                const viaJson = await send('POST', `json.value.${i}`, body, 'application/json');
                const viaText = await send('POST', `text.value.${i}`, body, 'text/plain');
                assert.strictEqual(viaJson.status, 201, `application/json ${body}`);
                assert.strictEqual(viaText.status, 201, `text/plain ${body}`);

                const storedJson = await read(`json.value.${i}`);
                const storedText = await read(`text.value.${i}`);
                assert.deepStrictEqual(storedJson.value, value, `application/json ${body} read back`);
                assert.deepStrictEqual(storedJson, storedText, `${body}: both paths store the same document`);
            }
        });

        test('structured +json types and an explicit charset are accepted', async () => {
            const a = await send('POST', 'json.vnd', JSON.stringify({ t: 'vnd' }), 'application/vnd.api+json');
            const b = await send('POST', 'json.charset', JSON.stringify({ t: 'utf8' }), 'application/json; charset=utf-8');
            assert.strictEqual(a.status, 201);
            assert.strictEqual(b.status, 201);
            assert.deepStrictEqual((await read('json.vnd')).value, { t: 'vnd' });
            assert.deepStrictEqual((await read('json.charset')).value, { t: 'utf8' });
        });
    });

    describe('scripts run only from text/plain', () => {
        test('the text/plain javascript: envelope still executes', async () => {
            await send('POST', 'script.counter', JSON.stringify({ n: 1 }), 'text/plain');
            const res = await send('PUT', 'script.counter',
                'javascript: data.n = data.n + body.add; response = data.n; javascript! {"add": 2}', 'text/plain');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(await res.json(), 3);
            assert.deepStrictEqual((await read('script.counter')).value, { n: 3 });
        });

        test('a JSON string that looks like a script is stored as data, never executed', async () => {
            const lookalike = 'javascript: data = "executed"; response = "executed"; javascript! {}';
            const res = await send('POST', 'script.lookalike', JSON.stringify(lookalike), 'application/json');
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual(await res.json(), { ok: 'successfull' });
            assert.strictEqual((await read('script.lookalike')).value, lookalike);
        });

        test('an object holding "javascript:" as a value is stored as data', async () => {
            const doc = { note: 'javascript: response = 1; javascript!' };
            const res = await send('POST', 'script.inobject', JSON.stringify(doc), 'application/json');
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual((await read('script.inobject')).value, doc);
        });
    });

    describe('unreadable bodies are refused with a JSON error', () => {
        test('malformed JSON is a 400 with a JSON body, not an HTML page or a stack trace', async () => {
            const res = await send('POST', 'bad.json', '{"broken": ', 'application/json');
            assert.strictEqual(res.status, 400);
            assert.match(res.headers.get('content-type'), /application\/json/);
            const body = await res.json();
            assert.match(body.error, /^Malformed JSON body/);
            assert.strictEqual(body.stack, undefined);
            assert.strictEqual((await read('bad.json')).status, 404, 'nothing was stored');
        });

        test('malformed JSON sent as text/plain is a 400 too, no longer a 500', async () => {
            const res = await send('POST', 'bad.text', '{"broken": ', 'text/plain');
            assert.strictEqual(res.status, 400);
            assert.match((await res.json()).error, /JSON/);
            assert.strictEqual((await read('bad.text')).status, 404, 'nothing was stored');
        });

        test('application/octet-stream is refused with 415 and nothing is stored', async () => {
            const res = await send('POST', 'bad.octet', JSON.stringify({ important: 'payload' }), 'application/octet-stream');
            assert.strictEqual(res.status, 415);
            assert.match((await res.json()).error, /Unsupported Content-Type "application\/octet-stream"/);
            assert.strictEqual((await read('bad.octet')).status, 404);
        });

        test('a PUT with an unreadable body leaves the stored document untouched', async () => {
            await send('POST', 'bad.put', JSON.stringify({ keep: true }), 'application/json');
            const res = await send('PUT', 'bad.put', 'whatever', 'application/octet-stream');
            assert.strictEqual(res.status, 415);
            assert.deepStrictEqual((await read('bad.put')).value, { keep: true });
        });

        test('a form-urlencoded body (curl -d without a header) is refused', async () => {
            const res = await send('POST', 'bad.form', 'a=1&b=2', 'application/x-www-form-urlencoded');
            assert.strictEqual(res.status, 415);
            assert.strictEqual((await read('bad.form')).status, 404);
        });

        test('a multipart type other than form-data is refused with 415, not a 500', async () => {
            const body = multipartBody('xyz', [{ name: 'part', value: 'data' }]);
            const res = await raw(srv, { method: 'POST', path: '/keys/bad.mixed', headers: { 'Content-Type': 'multipart/mixed; boundary=xyz', 'Content-Length': String(Buffer.byteLength(body)) }, body });
            assert.strictEqual(res.status, 415);
            assert.strictEqual((await read('bad.mixed')).status, 404);
        });

        test('a body without any Content-Type is refused', async () => {
            const res = await raw(srv, { method: 'POST', path: '/keys/bad.notype', headers: { 'Content-Length': '7' }, body: '{"a":1}' });
            assert.strictEqual(res.status, 415);
            assert.match(JSON.parse(res.text).error, /^Missing Content-Type/);
        });
    });

    describe('JSON bodies get the per-key size limit', () => {
        const sized = (n) => JSON.stringify({ pad: 'x'.repeat(n) });

        test('a JSON body over its key limit is a 413 with a JSON body', async () => {
            const res = await send('POST', 'small.json', sized(4096), 'application/json');
            assert.strictEqual(res.status, 413);
            assert.match((await res.json()).error, /larger than the 1KB allowed/);
            assert.strictEqual((await read('small.json')).status, 404);
        });

        test('the same body over the limit as text/plain is refused the same way', async () => {
            const res = await send('POST', 'small.text', sized(4096), 'text/plain');
            assert.strictEqual(res.status, 413);
            assert.match((await res.json()).error, /larger than the 1KB allowed/);
        });

        test('a file over its key limit is a 413 with a JSON body as well', async () => {
            const form = new FormData();
            form.append('file', new Blob(['x'.repeat(4096)], { type: 'text/plain' }), 'big.txt');
            const res = await fetch(`${srv.base}/keys/small.file`, { method: 'POST', headers: srv.auth, body: form });
            assert.strictEqual(res.status, 413);
            assert.match(res.headers.get('content-type'), /application\/json/);
            assert.match((await res.json()).error, /larger than the 1KB allowed/);
        });

        test('without a valid token the body is never read: 401, not 413', async () => {
            const res = await fetch(`${srv.base}/keys/small.noauth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: sized(4096)
            });
            assert.strictEqual(res.status, 401);
        });

        test('a key allowed more than payload_limit accepts a JSON body above payload_limit', async () => {
            // payload_limit is 1kb, so this passes only if the key's own limit applies.
            const res = await send('POST', 'big.json', sized(64 * 1024), 'application/json');
            assert.strictEqual(res.status, 201);
            assert.strictEqual((await read('big.json')).value.pad.length, 64 * 1024);
        });
    });

    describe('other request paths', () => {
        test('an empty POST still creates the key with a null value, whatever its Content-Type', async () => {
            const res = await raw(srv, { method: 'POST', path: '/keys/same.empty', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '0' } });
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual(await read('same.empty'), { status: 200, value: null });
        });

        test('DELETE with a client default Content-Type and no body still deletes', async () => {
            await send('POST', 'same.delete', '{"a":1}', 'text/plain');
            const res = await raw(srv, { method: 'DELETE', path: '/keys/same.delete', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '0' } });
            assert.strictEqual(res.status, 204);
        });

        test('an empty application/json body counts as no body, exactly like text/plain', async () => {
            const sized0 = await raw(srv, { method: 'POST', path: '/keys/same.emptyjson', headers: { 'Content-Type': 'application/json', 'Content-Length': '0' } });
            const chunked = await raw(srv, { method: 'POST', path: '/keys/same.emptychunked', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } });
            const text = await raw(srv, { method: 'POST', path: '/keys/same.emptytext', headers: { 'Content-Type': 'text/plain', 'Content-Length': '0' } });
            assert.deepStrictEqual([sized0.status, chunked.status, text.status], [201, 201, 201]);
            assert.strictEqual((await read('same.emptyjson')).value, null);
            assert.strictEqual((await read('same.emptychunked')).value, null);
            assert.strictEqual((await read('same.emptytext')).value, null);
        });

        test('a GET carrying an unreadable body is not refused, since nothing is written', async () => {
            await send('POST', 'same.get', '{"a":1}', 'text/plain');
            const res = await raw(srv, { method: 'GET', path: '/keys/same.get', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '8' }, body: 'whatever' });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(JSON.parse(res.text), { a: 1 });
        });

        test('a read through X-Method-Override: GET with a JSON body returns the document', async () => {
            await send('POST', 'same.override', '{"a":2}', 'text/plain');
            const res = await send('POST', 'same.override', JSON.stringify({ ignored: true }), 'application/json', { 'X-Method-Override': 'GET' });
            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(await res.json(), { a: 2 });
        });

        test('a file upload with an extra form field next to the file works (it used to fail with a 500)', async () => {
            const form = new FormData();
            form.append('file', new Blob(['hello file'], { type: 'text/plain' }), 'hello.txt');
            form.append('note', 'an extra field');
            const res = await fetch(`${srv.base}/keys/same.upload`, { method: 'POST', headers: srv.auth, body: form });
            assert.strictEqual(res.status, 201);
            assert.deepStrictEqual(await res.json(), { ok: 'upload successfull' });
        });

        test('an upload with a capitalised Multipart/Form-Data header stores the file', async () => {
            const body = multipartBody('b0und', [{ name: 'file', filename: 'caps.txt', value: 'hello caps' }, { name: 'note', value: 'extra' }]);
            const res = await raw(srv, { method: 'POST', path: '/keys/same.caps', headers: { 'Content-Type': 'Multipart/Form-Data; boundary=b0und', 'Content-Length': String(Buffer.byteLength(body)) }, body });
            assert.strictEqual(res.status, 201);
            const stored = (await read('same.caps')).value;
            assert.strictEqual(typeof stored, 'string', 'the file, not the form fields, is stored');
            assert.strictEqual(Buffer.from(stored, 'base64').toString(), 'hello caps');
        });

        test('a parser error still carries the CORS headers a browser needs to read it', async () => {
            const res = await send('POST', 'same.cors', '{"broken": ', 'application/json', { Origin: 'https://app.example' });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://app.example');
        });

        test('login still reads its JSON body, and malformed login JSON is now a JSON 400, not an HTML page', async () => {
            const ok = await fetch(`${srv.base}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: 'admin', password: 'secret' })
            });
            assert.strictEqual(ok.status, 200);
            assert.ok((await ok.json()).token);

            const bad = await fetch(`${srv.base}/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: '{"username": '
            });
            assert.strictEqual(bad.status, 400);
            assert.match((await bad.json()).error, /^Malformed JSON body/);
        });
    });
});
