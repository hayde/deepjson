// Tests for the wildcard-key guard at the top of handleKeyRequest().
//
// Only exercises the guard itself: this.processWildcardKey() is stubbed to throw
// a distinctive sentinel error, so "did we reach key generation" can be observed
// via the response without needing to mock the rest of the read/write pipeline.
//
// Run with: node --test test/handleKeyRequest.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const REACHED_GENERATION = 'REACHED_WILDCARD_GENERATION';

function makeReq({ method, overwriteMethodHeader, key = 'some.prefix.*' } = {}) {
    return {
        method,
        headers: overwriteMethodHeader ? { 'x-method-override': overwriteMethodHeader } : {},
        params: { key },
        query: {}
    };
}

function makeRes(overwriteMethod) {
    return {
        locals: { overwriteMethod: overwriteMethod || null },
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; }
    };
}

async function run({ method, overwriteMethodHeader, key }) {
    // Prototype-linked, because handleKeyRequest() now routes write methods through
    // withKeyLock() before reaching the guard under test. The lock itself is covered
    // in concurrency.test.js; here it just has to be present and functional.
    const harness = Object.create(DeepJSONServer.prototype);
    Object.assign(harness, {
        index: new Map(),
        _keyLocks: new Map(),
        // Sentinel: throwing here proves the guard let the request through to
        // actual key generation. handleKeyRequest's own try/catch turns this
        // into a 500 response carrying the sentinel message.
        processWildcardKey: async () => { throw new Error(REACHED_GENERATION); },
        logRequest: async () => {}
    });
    const req = makeReq({ method, overwriteMethodHeader, key });
    const res = makeRes(overwriteMethodHeader ? overwriteMethodHeader.toUpperCase() : null);
    await DeepJSONServer.prototype.handleKeyRequest.call(harness, req, res);
    return res;
}

describe('handleKeyRequest wildcard-key guard', () => {
    test('a genuine POST with no method override reaches key generation', async () => {
        const res = await run({ method: 'POST', key: 'some.prefix.*' });
        assert.strictEqual(res.statusCode, 500); // sentinel error surfaced, not a 403
        assert.match(res.body.error, new RegExp(REACHED_GENERATION));
    });

    test('a non-POST method is rejected before key generation', async () => {
        const res = await run({ method: 'GET', key: 'some.prefix.*' });
        assert.strictEqual(res.statusCode, 403);
        assert.match(res.body.error, /only allowed for POST/);
    });

    test('a GET disguised as POST via X-Method-Override is rejected, not allowed through', async () => {
        // Regression test: res.overwriteMethod (always undefined, typo for
        // res.locals.overwriteMethod) used to make this guard dead code, so a
        // request could flip its effective method to POST via the override
        // header and still trigger wildcard key generation.
        const res = await run({ method: 'GET', overwriteMethodHeader: 'POST', key: 'some.prefix.*' });
        assert.strictEqual(res.statusCode, 403);
        assert.match(res.body.error, /without "overwrite-Method" header/);
    });

    test('a real POST that also carries a redundant POST override is still rejected', async () => {
        const res = await run({ method: 'POST', overwriteMethodHeader: 'POST', key: 'some.prefix.*' });
        assert.strictEqual(res.statusCode, 403);
        assert.match(res.body.error, /without "overwrite-Method" header/);
    });
});
