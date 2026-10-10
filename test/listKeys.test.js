// Tests for key listing, the cheap query path.
//
// Background: this endpoint ran checkPermissions() over every key in the index
// and only then applied the caller's name filter. checkPermissions() walks every
// group and every rule, so it is by far the expensive half - on an 11691-key index
// with five rules a prefix query took 220ms, of which almost all was permission
// work on keys the filter was about to discard. Filtering names first brought the
// same query to 88ms. It also had no limit, returning 613KB for that index, and an
// unparseable pattern produced an Express 500 rather than a 400.
//
// Run with: node --test test/listKeys.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

function harness({ keys = [], rules = [{ regex: '.*', crudx: '11111' }], config = {} } = {}) {
    const h = Object.create(DeepJSONServer.prototype);
    h.config = config;
    h.index = new Map(keys.map(k => [k, {}]));
    h.accessData = {
        users: { u: { id: 'u', groups: ['g'] } },
        groups: { g: { rules } }
    };
    return h;
}

function call(h, source, method = 'GET') {
    const req = { method, user: { id: 'u' }, query: {}, body: {} };
    if (method === 'GET') req.query = source; else req.body = source;

    let status = 200, body = null;
    const res = {
        status(code) { status = code; return res; },
        json(payload) { body = payload; return res; }
    };
    h.handleListKeys(req, res);
    return { status, body };
}

const SAMPLE = [
    'de.alpha.site.doc.1', 'de.alpha.site.doc.2', 'de.alpha.site.doc.3',
    'de.beta.site.doc.1', 'de.beta.site.doc.2',
    'eu.gamma.site.doc.1'
];

describe('listing and filtering', () => {
    test('with no filter it returns every readable key plus a total', () => {
        const { body } = call(harness({ keys: SAMPLE }), {});
        assert.strictEqual(body.total, 6);
        assert.strictEqual(body.keys.length, 6);
    });

    test('a pattern filters on the key name', () => {
        const { body } = call(harness({ keys: SAMPLE }), { keys: '^de\\.alpha\\.' });
        assert.deepStrictEqual(body.keys, ['de.alpha.site.doc.1', 'de.alpha.site.doc.2', 'de.alpha.site.doc.3']);
        assert.strictEqual(body.total, 3);
    });

    test('keys the caller cannot read are excluded, filtered or not', () => {
        const h = harness({
            keys: SAMPLE,
            rules: [{ regex: '.*', crudx: '11111' }, { regex: '^eu\\..*', crudx: '00000' }]
        });
        assert.strictEqual(call(h, {}).body.total, 5, 'the eu key is not readable');
        assert.strictEqual(call(h, { keys: '^eu\\.' }).body.total, 0,
            'filtering must not smuggle past the permission check');
    });

    test('an unparseable pattern is a 400 that names the problem', () => {
        const { status, body } = call(harness({ keys: SAMPLE }), { keys: '^de\\.[' });
        assert.strictEqual(status, 400);
        assert.match(body.error, /not a valid regular expression/);
    });

    test('POST takes the same options from the body', () => {
        const { body } = call(harness({ keys: SAMPLE }), { keys: '^de\\.beta\\.' }, 'POST');
        assert.strictEqual(body.total, 2);
    });
});

describe('limit, offset and count', () => {
    test('limit caps the page but total still reports the whole match', () => {
        const { body } = call(harness({ keys: SAMPLE }), { limit: 2 });
        assert.strictEqual(body.keys.length, 2);
        assert.strictEqual(body.total, 6);
        assert.strictEqual(body.limit, 2);
        assert.strictEqual(body.truncated, true);
    });

    test('offset walks through the result', () => {
        const h = harness({ keys: SAMPLE });
        const first = call(h, { limit: 4 }).body;
        const second = call(h, { limit: 4, offset: 4 }).body;

        assert.strictEqual(first.truncated, true);
        assert.strictEqual(second.truncated, false, 'the last page is not truncated');
        assert.deepStrictEqual([...first.keys, ...second.keys].sort(), [...SAMPLE].sort());
    });

    test('an offset past the end is an empty page, not an error', () => {
        const { status, body } = call(harness({ keys: SAMPLE }), { offset: 99 });
        assert.strictEqual(status, 200);
        assert.deepStrictEqual(body.keys, []);
        assert.strictEqual(body.total, 6);
    });

    test('count returns the number without the keyspace', () => {
        const { body } = call(harness({ keys: SAMPLE }), { count: 'true', keys: '^de\\.' });
        assert.strictEqual(body.total, 5);
        assert.strictEqual(body.keys, undefined, 'a count must not ship the keys');
    });

    test('nonsense bounds are rejected rather than guessed at', () => {
        for (const bad of [{ limit: -1 }, { limit: 'many' }, { offset: -5 }, { offset: 1.5 }]) {
            const { status, body } = call(harness({ keys: SAMPLE }), bad);
            assert.strictEqual(status, 400, JSON.stringify(bad));
            assert.match(body.error, /must be a non-negative integer/);
        }
    });

    test('an unlimited listing stays unlimited, as it always was', () => {
        const { body } = call(harness({ keys: SAMPLE }), {});
        assert.strictEqual(body.limit, undefined);
        assert.strictEqual(body.truncated, undefined);
        assert.strictEqual(body.keys.length, 6);
    });
});

describe('key_list_limit', () => {
    test('caps a listing that asks for no limit', () => {
        const h = harness({ keys: SAMPLE, config: { key_list_limit: 2 } });
        const { body } = call(h, {});
        assert.strictEqual(body.keys.length, 2);
        assert.strictEqual(body.total, 6);
        assert.strictEqual(body.truncated, true);
    });

    test('a client cannot ask for more than the cap', () => {
        const h = harness({ keys: SAMPLE, config: { key_list_limit: 2 } });
        assert.strictEqual(call(h, { limit: 100 }).body.keys.length, 2);
    });

    test('a client may still ask for less', () => {
        const h = harness({ keys: SAMPLE, config: { key_list_limit: 4 } });
        assert.strictEqual(call(h, { limit: 1 }).body.keys.length, 1);
    });

    test('is rejected at startup unless it is a positive integer', () => {
        const base = (key_list_limit) => {
            const srv = Object.create(DeepJSONServer.prototype);
            srv.config = {
                data_root: '/tmp/x', access_file: '/tmp/x/access.json',
                jwt_secret: 'x'.repeat(40), port: 8080, index_depth: 2, key_list_limit
            };
            srv.accessData = {
                users: { a: { id: 'a', password: 'scrypt:a:b', groups: ['g'] } },
                groups: { g: { rules: [{ regex: '.*', crudx: '11110' }] } }
            };
            return () => srv.validateConfig();
        };
        assert.doesNotThrow(base(500));
        assert.doesNotThrow(base(undefined));
        assert.throws(base(0), /key_list_limit must be a positive integer/);
        assert.throws(base(-1), /key_list_limit must be a positive integer/);
        assert.throws(base('lots'), /key_list_limit must be a positive integer/);
    });
});

describe('the permission check runs only on what the filter kept', () => {
    test('a narrow filter means far fewer permission evaluations', () => {
        let evaluations = 0;
        const h = harness({ keys: SAMPLE });
        const real = DeepJSONServer.prototype.checkPermissions;
        h.checkPermissions = function (...args) { evaluations++; return real.apply(this, args); };

        call(h, { keys: '^de\\.alpha\\.' });

        assert.strictEqual(evaluations, 3,
            'only the three matching keys should be permission-checked, not all six');
    });
});
