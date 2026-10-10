// Tests for `abort`, the way a script refuses an operation.
//
// Background: a script had no way to say "do not write". The sandbox wrapper
// always returns `data`, so a script that set only an error on `response` still
// handed back a storable document, and the server stored it - incrementing
// `_modCounter` and appending to the index for an operation the script had already
// rejected. A reservation script doing exactly that is how one production key
// reached 34245 modifications: every failed attempt wrote too, so any client
// tracking that document's version saw it move for nothing.
//
// Two layers are covered here: `abort` crossing the sandbox boundary, and
// resolveScriptAbort() turning it into a status and body.
//
// Run with: node --test test/scriptAbort.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

// Mirrors what processScriptBody() passes, including the keys seeded as undefined:
// those keys becoming sandbox globals is what lets a script assign to them at all
// under "use strict".
function baseContext() {
    return {
        origin: undefined,
        custom: undefined,
        body: undefined,
        data: undefined,
        user: undefined,
        http_method: undefined,
        key: undefined,
        hash: undefined,
        response: undefined,
        abort: undefined
    };
}

function run(code, context = {}) {
    const harness = { config: { script_execution_time_limit: 300 } };
    return DeepJSONServer.prototype.executeScript.call(
        harness, null, code, { ...baseContext(), ...context }
    );
}

const resolve = (abort) => DeepJSONServer.prototype.resolveScriptAbort(abort);

describe('abort crosses the sandbox boundary', () => {
    test('a script that does not abort reports no abort', async () => {
        const result = await run('data = { ok: 1 };');
        assert.strictEqual(result.abort, undefined);
        assert.deepStrictEqual(result.data, { ok: 1 });
    });

    test('abort = true comes back', async () => {
        const result = await run('abort = true;');
        assert.strictEqual(result.abort, true);
    });

    test('a message survives', async () => {
        const result = await run('abort = "no slots left";');
        assert.strictEqual(result.abort, 'no slots left');
    });

    test('a status and error object survive', async () => {
        const result = await run('abort = { status: 409, error: { code: "CONFLICT" } };');
        assert.deepStrictEqual(result.abort, { status: 409, error: { code: 'CONFLICT' } });
    });

    test('abort can be decided from the stored document', async () => {
        const code = `
            if (data.status !== 'draft') {
                abort = { status: 409, error: 'only drafts may be edited' };
            } else {
                data.status = 'published';
            }
        `;
        const published = await run(code, { data: { status: 'published' } });
        assert.deepStrictEqual(published.abort, { status: 409, error: 'only drafts may be edited' });

        const draft = await run(code, { data: { status: 'draft' } });
        assert.strictEqual(draft.abort, undefined);
        assert.strictEqual(draft.data.status, 'published');
    });

    test('arbitrary boolean logic works, including XOR', async () => {
        // The point of using the sandbox rather than a header grammar: this needs
        // no new syntax, parser or operator precedence rules.
        const code = `
            var set = (data.flagA ? 1 : 0) + (data.flagB ? 1 : 0);
            if (set !== 1) abort = "exactly one flag must be set";
        `;
        assert.strictEqual((await run(code, { data: { flagA: true, flagB: false } })).abort, undefined);
        assert.strictEqual((await run(code, { data: { flagA: true, flagB: true } })).abort,
            'exactly one flag must be set');
        assert.strictEqual((await run(code, { data: { flagA: false, flagB: false } })).abort,
            'exactly one flag must be set');
    });

    test('abort and data can both be set; the server decides which wins', async () => {
        // A script may well mutate data before discovering it must refuse. The
        // handler checks abort first, so the mutation is discarded.
        const result = await run('data = { mutated: true }; abort = "changed my mind";');
        assert.strictEqual(result.abort, 'changed my mind');
        assert.deepStrictEqual(result.data, { mutated: true });
    });
});

describe('resolveScriptAbort', () => {
    test('no abort means no abort', () => {
        assert.strictEqual(resolve(undefined), null);
        assert.strictEqual(resolve(null), null);
        assert.strictEqual(resolve(false), null);
    });

    test('true gives 412 and a generic message', () => {
        assert.deepStrictEqual(resolve(true), {
            status: 412,
            error: { error: 'Operation aborted by script' }
        });
    });

    test('a string becomes the message, still 412', () => {
        assert.deepStrictEqual(resolve('no slots left'), {
            status: 412,
            error: { error: 'no slots left' }
        });
    });

    test('an explicit status is honoured', () => {
        assert.deepStrictEqual(resolve({ status: 409, error: 'conflict' }), {
            status: 409,
            error: { error: 'conflict' }
        });
    });

    test('a structured error body passes through unchanged', () => {
        const body = { code: 'NO_RANGE', detail: 'gap pool exhausted', retryAfter: 30 };
        assert.deepStrictEqual(resolve({ status: 409, error: body }), { status: 409, error: body });
    });

    test('a status without an error still gets a message', () => {
        assert.deepStrictEqual(resolve({ status: 404 }), {
            status: 404,
            error: { error: 'Operation aborted by script' }
        });
    });

    test('a script cannot claim success for an operation that did not happen', () => {
        for (const status of [200, 201, 204, 302, 399]) {
            assert.strictEqual(resolve({ status }).status, 412, `${status} must not be allowed`);
        }
    });

    test('out-of-range and nonsense statuses fall back to 412', () => {
        for (const status of [600, 999, 0, -1, 'teapot', null, undefined, 4.5]) {
            assert.strictEqual(resolve({ status }).status, 412, `${JSON.stringify(status)} must fall back`);
        }
    });

    test('a truthy non-string, non-object aborts with the default', () => {
        assert.deepStrictEqual(resolve(1), {
            status: 412,
            error: { error: 'Operation aborted by script' }
        });
    });
});
