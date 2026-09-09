// Test suite for DeepJSONServer#executeScript (the untrusted-script sandbox).
//
// Purpose: a fixed, runnable spec of what "correct sandbox behavior" means,
// checked against the real engine in use (quickjs-emscripten by default).
// If a future engine is added, this same spec should run against it too.
//
// Run with: node --test test/scriptEngine.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

// executeScript() only reads this.config.script_execution_time_limit/script_engine
// and doesn't touch fs/index/accessData, so we can call it against a minimal fake
// `this` instead of bootstrapping a full server with real config files on disk.
//
// The real caller (processScriptBody, server.js) always passes `data` and
// `response` as explicit keys (even when undefined/null) alongside origin,
// custom, body, user, http_method, key, hash -- those keys becoming sandbox
// globals is what lets a script reference `data`/`response` at all under
// "use strict". Match that contract here so tests reflect real usage.
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
        response: null
    };
}

function run(code, context = {}, config = {}) {
    const harness = { config: { script_execution_time_limit: 300, ...config } };
    return DeepJSONServer.prototype.executeScript.call(
        harness, /* req */ null, code, { ...baseContext(), ...context }
    );
}

describe('functional correctness', () => {
    test('script can set data on a modifiable call', async () => {
        const result = await run('data = "hello";', {});
        assert.strictEqual(result.data, 'hello');
    });

    test('script can read context values (origin, data, custom, user, http_method, key, hash)', async () => {
        const result = await run(
            'response = { origin, data, custom, user, http_method, key, hash };',
            {
                origin: { value: 'orig' },
                data: 'the-data',
                custom: 'the-custom',
                user: 'alice',
                http_method: 'PUT',
                key: 'some.key',
                hash: 'deadbeef'
            }
        );
        assert.deepStrictEqual(result.response, {
            origin: { value: 'orig' },
            data: 'the-data',
            custom: 'the-custom',
            user: 'alice',
            http_method: 'PUT',
            key: 'some.key',
            hash: 'deadbeef'
        });
    });

    test('script can set response directly', async () => {
        const result = await run('response = { ok: true, n: 42 };', {});
        assert.deepStrictEqual(result.response, { ok: true, n: 42 });
    });

    test('thrown errors inside the script surface as a wrapped "Script failed" error', async () => {
        await assert.rejects(
            run('throw new Error("boom");', {}),
            /Script failed: "boom"/
        );
    });

    test('JSON round-trip preserves nested objects, arrays, unicode, numbers, booleans, null', async () => {
        const payload = { a: [1, 2, 3], b: { nested: true }, s: 'héllo wörld 🎉', n: -3.5, z: null };
        const result = await run('data = JSON.parse(JSON.stringify(origin));', { origin: payload });
        assert.deepStrictEqual(result.data, payload);
    });

    test('runs in strict mode (assigning to an undeclared variable throws)', async () => {
        await assert.rejects(
            run('undeclaredVar = 1;', {}),
            /Script failed/
        );
    });
});

describe('timeout enforcement', () => {
    test('a script within the time limit completes normally', async () => {
        const result = await run('data = "fast";', {}, { script_execution_time_limit: 300 });
        assert.strictEqual(result.data, 'fast');
    });

    test('an infinite loop is aborted at the configured timeout, not hung forever', async () => {
        await assert.rejects(
            run('while(true) {}', {}, { script_execution_time_limit: 200 }),
            /Script exceeded maximum execution time/
        );
    });
});

describe('memory enforcement', () => {
    // Slower / can be flaky depending on how the engine polls its memory limit.
    // This is the single most important case to re-verify on any future engine --
    // it's the property that's easiest to get "mostly right" but not airtight.
    test('a memory-bomb script is aborted instead of exhausting host memory', async () => {
        const bomb = `
            var chunks = [];
            while (true) {
                chunks.push('x'.repeat(1e6)); // ~1MB per iteration, limit is 50MB
            }
        `;
        await assert.rejects(run(bomb, {}, { script_execution_time_limit: 5000 }));
    });
});

describe('sandbox escape attempts (must stay blocked)', () => {
    test('process is not reachable', async () => {
        // QuickJS contexts start with no Node globals at all by default --
        // process/require/fs/fetch are simply absent, not explicitly nulled.
        const result = await run('data = typeof process;', {});
        assert.strictEqual(result.data, 'undefined');
    });

    test('require is not reachable', async () => {
        await assert.rejects(run('require("fs");', {}));
    });

    test('cannot reach the filesystem through any global', async () => {
        await assert.rejects(run('data = fs.readFileSync("/etc/passwd", "utf8");', {}));
    });

    test('fetch / outbound network is not reachable', async () => {
        await assert.rejects(run('fetch("http://example.com");', {}));
    });

    test('eval works but stays fully contained inside the sandbox', async () => {
        // Unlike vm2, QuickJS doesn't need to forbid eval: anything eval'd still
        // runs inside the same WASM-isolated realm, so it can't reach the host
        // regardless of what it evaluates.
        const result = await run('data = eval("1+1") + "," + eval("typeof process");', {});
        assert.strictEqual(result.data, '2,undefined');
    });

    test('cannot escape the sandbox via constructor chain to reach host globals', async () => {
        // Classic escape shape: walk .constructor.constructor from an ordinary
        // object to reach the un-sandboxed Function constructor, then use it to
        // read host globals. (Not `this.constructor` -- under strict mode a plain
        // function call's `this` is undefined, so that would throw before even
        // attempting the escape.)
        const result = await run(
            'data = [].constructor.constructor("return typeof process")();',
            {}
        );
        assert.strictEqual(result.data, 'undefined');
    });

    // TODO: if a second engine (e.g. isolated-vm) is added later, pull the actual
    // PoC payloads from the vm2 CVE advisories (e.g. GHSA-cchq-frgv-rjh5,
    // GHSA-g644-9gfx-q4q4) and add them here verbatim as regression tests against
    // that engine. Not fabricating exploit code from memory -- want to verify
    // against the real published PoCs, not a guess.
    test.todo('known vm2-style CVE escape payloads are blocked on any additional engine');
});

describe('isolation between calls', () => {
    test('global state does not leak between separate executions', async () => {
        await run('globalThis.leaked = "leftover";', {});
        // Fresh sandbox for a second, unrelated call -- must not see the mutation above.
        const result = await run('data = (typeof leaked === "undefined") ? "clean" : "leaked";', {});
        assert.strictEqual(result.data, 'clean');
    });
});

// If a second ScriptEngine is added, add a parity block here that runs every
// case above through both engines and asserts identical results, so callers
// can't observe which engine is configured.
