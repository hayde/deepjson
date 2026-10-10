// Tests for conditional context injection.
//
// Background: processScriptBody() handed every script the full context regardless
// of what it used. `origin` is the whole stored record and `data` its value, and
// the context crosses the sandbox boundary as a single JSON string - so a write
// that only attached metadata still serialized the document twice. Three
// production failures came from it on documents of 222-396MB: a sandbox
// out-of-memory, a V8 "Invalid string length", and a script timeout.
//
// The subtlety is that every context value round-trips: the wrapper hands back
// data/custom/response/abort, which is how an untouched `custom` survives a write
// and how `data = data` preserves a document. Withholding a value therefore breaks
// that round trip, so anything withheld is restored host-side and the caller
// cannot tell the difference. These tests pin both halves down.
//
// Run with: node --test test/scriptInjection.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const refs = (code) => DeepJSONServer.prototype.scriptReferences(code);

// processScriptBody() only needs executeScript() and req.user, so it can run
// against a minimal `this` and a stubbed engine that reports what it was given.
function harness() {
    const seen = {};
    const h = Object.create(DeepJSONServer.prototype);
    h.executeScript = async (req, code, context) => {
        seen.context = context;
        // Mimic the wrapper: every value handed in comes back out.
        return {
            response: context.response,
            data: context.data,
            custom: context.custom,
            abort: context.abort
        };
    };
    return { h, seen };
}

const record = (value, custom) => ({
    _key: 'k', _hash: 'h', _modCounter: 3, value, custom
});

describe('scriptReferences', () => {
    test('detects a plain read', () => {
        assert.strictEqual(refs('response = data.n;').data, true);
        assert.strictEqual(refs('response = origin._modCounter;').origin, true);
        assert.strictEqual(refs('custom.tag = 1;').custom, true);
    });

    test('detects an assignment, including the self-assignment idiom', () => {
        assert.strictEqual(refs('data = data;').data, true);
        assert.strictEqual(refs('data = { n: 1 };').data, true);
    });

    test('reports absence when a name is never mentioned', () => {
        const r = refs('custom.scanner = body; response = { ok: true };');
        assert.strictEqual(r.data, false);
        assert.strictEqual(r.origin, false);
        assert.strictEqual(r.custom, true);
    });

    test('respects word boundaries', () => {
        // These must not be mistaken for the real identifiers.
        const r = refs('response = { metadata: body.mydata, originator: 1 };');
        assert.strictEqual(r.data, false);
        assert.strictEqual(r.origin, false);
    });

    test('anything capable of dynamic access opts out entirely', () => {
        for (const src of [
            'response = globalThis["da" + "ta"];',
            'eval("response = data");',
            'response = new Function("return data")();',
            'with (this) { response = 1; }'
        ]) {
            const r = refs(src);
            assert.strictEqual(r.data, true, src);
            assert.strictEqual(r.origin, true, src);
            assert.strictEqual(r.custom, true, src);
        }
    });

    test('an empty or missing script references nothing', () => {
        assert.deepStrictEqual(refs(''), { data: false, origin: false, custom: false });
        assert.deepStrictEqual(refs(undefined), { data: false, origin: false, custom: false });
    });
});

describe('what reaches the sandbox', () => {
    const req = { user: { user: 'u' }, method: 'PUT' };

    test('a metadata-only script gets neither the document nor its value', async () => {
        const { h, seen } = harness();
        const big = { pdf: 'x'.repeat(10000) };

        await h.processScriptBody(req,
            'if (!custom) custom = {}; custom.scanner = body; response = { ok: true };',
            { boxNumber: 7 },
            record(big, { prior: true }));

        assert.strictEqual(seen.context.data, undefined, 'the value must stay behind');
        assert.strictEqual(seen.context.origin, undefined, 'the record must stay behind');
        assert.deepStrictEqual(seen.context.custom, { prior: true }, 'custom is referenced, so it goes');
        assert.deepStrictEqual(seen.context.body, { boxNumber: 7 });
        // The cheap identifying fields always travel; they are scalars.
        assert.strictEqual(seen.context.key, 'k');
        assert.strictEqual(seen.context.hash, 'h');
    });

    test('a script that reads the value still gets it', async () => {
        const { h, seen } = harness();
        await h.processScriptBody(req, 'response = data.n;', null, record({ n: 5 }));
        assert.deepStrictEqual(seen.context.data, { n: 5 });
    });

    test('a script that reads origin still gets the whole record', async () => {
        const { h, seen } = harness();
        const rec = record({ n: 5 });
        await h.processScriptBody(req, 'response = origin._modCounter;', null, rec);
        assert.deepStrictEqual(seen.context.origin, rec);
    });

    test('a missing document is not invented', async () => {
        const { h, seen } = harness();
        await h.processScriptBody(req, 'data = body;', { n: 1 }, undefined);
        assert.strictEqual(seen.context.data, undefined);
        assert.strictEqual(seen.context.origin, undefined);
    });
});

describe('withheld values are restored, so callers see no difference', () => {
    const req = { user: { user: 'u' }, method: 'PUT' };

    test('an unreferenced value comes back unchanged, as if it had round-tripped', async () => {
        const { h } = harness();
        const value = { n: 42, deep: { nested: true } };

        const result = await h.processScriptBody(req,
            'custom.scanner = body;', { a: 1 }, record(value, { prior: true }));

        // This is what _handleKeyRequest writes back as the document's value.
        assert.deepStrictEqual(result.data, value,
            'the stored value must survive a script that never mentions it');
    });

    test('an unreferenced custom survives too', async () => {
        const { h } = harness();
        const result = await h.processScriptBody(req,
            'data = { n: 1 };', null, record({ n: 0 }, { tag: 'important' }));

        assert.deepStrictEqual(result.custom, { tag: 'important' });
    });

    // The stub above only echoes what it was handed, so it cannot model a script
    // that assigns. These two run the real QuickJS sandbox instead, which also
    // proves the stub is not flattering the implementation.
    function realHarness() {
        const h = Object.create(DeepJSONServer.prototype);
        h.config = { script_execution_time_limit: 500 };
        return h;
    }

    test('a script that does assign wins over the restore', async () => {
        const h = realHarness();
        const result = await h.processScriptBody(req,
            'data = { replaced: true };', null, record({ n: 0 }));
        assert.deepStrictEqual(result.data, { replaced: true });
    });

    test('through the real sandbox, a withheld value still comes back intact', async () => {
        const h = realHarness();
        const value = { n: 42, deep: { nested: true } };

        const result = await h.processScriptBody(req,
            'if (!custom) custom = {}; custom.scanner = body; response = { ok: true };',
            { boxNumber: 7 },
            record(value, { prior: true }));

        assert.deepStrictEqual(result.data, value, 'the value never entered the sandbox, yet survives');
        assert.deepStrictEqual(result.custom, { prior: true, scanner: { boxNumber: 7 } });
        assert.deepStrictEqual(result.response, { ok: true });
    });

    test('restoring never resurrects a document that does not exist', async () => {
        const { h } = harness();
        const result = await h.processScriptBody(req, 'response = 1;', null, undefined);
        assert.strictEqual(result.data, undefined,
            'a create must still report undefined data, which the caller rejects');
        assert.strictEqual(result.custom, undefined);
    });

    test('no script means no context at all', async () => {
        const { h } = harness();
        assert.strictEqual(await h.processScriptBody(req, null, { a: 1 }, record({})), null);
    });
});
