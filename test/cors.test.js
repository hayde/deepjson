// Tests for the per-group CORS origin allowlist:
//   - getAllowedCorsOrigins() (server.js): unions every group's `allowed_origins`
//     from access.json into one Set. Origins only ever accumulate across groups;
//     group membership is not checked per request (CORS preflights carry no auth,
//     so the server can't yet know which user/group is asking - see the comment
//     above the cors() call in setupServer()).
//   - the actual `cors` middleware wired up with that whitelist, exercised end to
//     end against a real http server (no mocking of the `cors` package itself),
//     since header-setting behavior on allow/deny is exactly what matters here.
//
// Run with: node --test test/cors.test.js

const assert = require('node:assert');
const http = require('node:http');
const { test, describe } = require('node:test');
const cors = require('cors');
const DeepJSONServer = require('../server');

function getAllowedCorsOrigins(groups) {
    return DeepJSONServer.prototype.getAllowedCorsOrigins.call({ accessData: { groups } });
}

function isOriginAllowed(groups, origin) {
    const harness = {
        accessData: { groups },
        getAllowedCorsOrigins: DeepJSONServer.prototype.getAllowedCorsOrigins
    };
    return DeepJSONServer.prototype.isOriginAllowed.call(harness, origin);
}

describe('isOriginAllowed', () => {
    // Shared by the Express CORS middleware and socket.io's CORS block, so this
    // is the single decision point both paths depend on.
    const groups = { 'tenant-x': { allowed_origins: ['https://tenantx.example.com'] } };

    test('a whitelisted origin is allowed', () => {
        assert.strictEqual(isOriginAllowed(groups, 'https://tenantx.example.com'), true);
    });

    test('an origin outside the whitelist is refused', () => {
        assert.strictEqual(isOriginAllowed(groups, 'https://evil.example.com'), false);
    });

    test('a missing Origin header (curl, server-to-server) is always allowed', () => {
        assert.strictEqual(isOriginAllowed(groups, undefined), true);
    });

    test('an empty whitelist leaves every origin allowed (pre-allowed_origins default)', () => {
        assert.strictEqual(isOriginAllowed({ editors: { rules: [] } }, 'https://anything.example.com'), true);
    });

    test('origin matching is exact - a different port or scheme does not match', () => {
        assert.strictEqual(isOriginAllowed(groups, 'http://tenantx.example.com'), false);
        assert.strictEqual(isOriginAllowed(groups, 'https://tenantx.example.com:8443'), false);
    });

    test('Origin: null is checked against the whitelist, not waved through', () => {
        // A file:// page or sandboxed iframe sends the literal string "null".
        // It must not be confused with "no Origin header at all", which is allowed.
        assert.strictEqual(isOriginAllowed(groups, 'null'), false);
        assert.strictEqual(isOriginAllowed(groups, undefined), true);
    });

    test('allowing Origin: null requires the quoted string, a JSON null matches nothing', () => {
        const quoted = { dev: { allowed_origins: ['null'] } };
        assert.strictEqual(isOriginAllowed(quoted, 'null'), true);

        // The silent-failure case worth guarding: a bare JSON null still counts
        // toward the whitelist size, so the open-by-default fallback stays off and
        // the entry can never match anything.
        const literal = { dev: { allowed_origins: [null] } };
        assert.strictEqual(getAllowedCorsOrigins(literal).size, 1);
        assert.strictEqual(isOriginAllowed(literal, 'null'), false);
        assert.strictEqual(isOriginAllowed(literal, 'https://anything.example.com'), false);
    });
});

describe('getAllowedCorsOrigins', () => {
    test('no groups at all -> empty whitelist', () => {
        assert.deepStrictEqual(getAllowedCorsOrigins({}), new Set());
    });

    test('groups without an allowed_origins field contribute nothing', () => {
        const origins = getAllowedCorsOrigins({ editors: { rules: [] } });
        assert.strictEqual(origins.size, 0);
    });

    test('origins from multiple groups are unioned', () => {
        const origins = getAllowedCorsOrigins({
            'tenant-x': { rules: [], allowed_origins: ['https://tenantx.example.com', 'https://app.tenantx.example.com'] },
            'tenant-y': { rules: [], allowed_origins: ['https://tenanty.example.com'] },
            'no-origins-here': { rules: [] }
        });
        assert.deepStrictEqual(
            [...origins].sort(),
            ['https://app.tenantx.example.com', 'https://tenantx.example.com', 'https://tenanty.example.com']
        );
    });

    test('the same origin listed in two groups is not duplicated', () => {
        const origins = getAllowedCorsOrigins({
            a: { rules: [], allowed_origins: ['https://shared.example.com'] },
            b: { rules: [], allowed_origins: ['https://shared.example.com'] }
        });
        assert.strictEqual(origins.size, 1);
    });
});

describe('cors() middleware wired with the origin allowlist', () => {
    // Same origin-callback logic as setupServer(): empty whitelist stays fully
    // open (backward compatible with the pre-whitelist default), a request with
    // no Origin header (non-browser clients) always passes, and an explicit
    // whitelist blocks anything not in it.
    function makeServer(allowedOrigins) {
        const middleware = cors({
            origin: (origin, callback) => {
                if (allowedOrigins.size === 0 || !origin || allowedOrigins.has(origin)) {
                    return callback(null, true);
                }
                callback(new Error(`Origin not allowed by CORS: ${origin}`));
            }
        });
        return http.createServer((req, res) => {
            middleware(req, res, (err) => {
                if (err) { res.statusCode = 500; res.end(); return; }
                res.statusCode = 200;
                res.end('ok');
            });
        });
    }

    function request(server, origin) {
        return new Promise((resolve, reject) => {
            server.listen(0, () => {
                const port = server.address().port;
                const headers = origin ? { Origin: origin } : {};
                http.get({ host: '127.0.0.1', port, headers }, (res) => {
                    res.resume();
                    res.on('end', () => {
                        server.close();
                        resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] });
                    });
                }).on('error', reject);
            });
        });
    }

    test('empty whitelist stays fully open (unchanged default)', async () => {
        const res = await request(makeServer(new Set()), 'https://anything.example.com');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.acao, 'https://anything.example.com');
    });

    test('a whitelisted origin is reflected back and allowed', async () => {
        const allowed = new Set(['https://tenantx.example.com']);
        const res = await request(makeServer(allowed), 'https://tenantx.example.com');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.acao, 'https://tenantx.example.com');
    });

    test('a non-whitelisted origin is rejected, no Allow-Origin header set', async () => {
        const allowed = new Set(['https://tenantx.example.com']);
        const res = await request(makeServer(allowed), 'https://evil.example.com');
        assert.strictEqual(res.acao, undefined);
    });

    test('a request with no Origin header (non-browser client) is always let through', async () => {
        const allowed = new Set(['https://tenantx.example.com']);
        const res = await request(makeServer(allowed), null);
        assert.strictEqual(res.status, 200);
    });
});
