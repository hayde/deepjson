// Tests for the per-key serialization and the atomic write.
//
// Background: writeKeyData() used to call fsp.writeFile() directly, truncating the
// target in place, and nothing serialized read -> script -> write. Under concurrent
// load that produced torn documents that could no longer be parsed or even deleted,
// plus silently lost updates. Measured before the fix: three workers doing 40 writes
// each on one key, 8 acknowledged, none surviving. After: 120 of 120, all surviving.
//
// Run with: node --test test/concurrency.test.js

const assert = require('node:assert');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

function locker() {
    const h = Object.create(DeepJSONServer.prototype);
    h._keyLocks = new Map();
    return h;
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));

describe('withKeyLock', () => {
    test('operations on the same key never overlap', async () => {
        const h = locker();
        const events = [];
        const job = (name) => h.withKeyLock('same', async () => {
            events.push(`${name}:start`);
            await wait(15);
            events.push(`${name}:end`);
        });

        await Promise.all([job('a'), job('b'), job('c')]);

        // Every start must be followed by its own end before the next one begins.
        assert.deepStrictEqual(events, [
            'a:start', 'a:end',
            'b:start', 'b:end',
            'c:start', 'c:end'
        ]);
    });

    test('different keys run concurrently and do not block each other', async () => {
        const h = locker();
        const order = [];
        await Promise.all([
            h.withKeyLock('one', async () => { await wait(30); order.push('slow'); }),
            h.withKeyLock('two', async () => { await wait(1); order.push('fast'); })
        ]);
        // If these were serialized, 'slow' would come first.
        assert.deepStrictEqual(order, ['fast', 'slow']);
    });

    test('read-modify-write under the lock keeps every update', async () => {
        const h = locker();
        let stored = 0;
        // Deliberately interleavable: read, pause, then write back.
        const increment = () => h.withKeyLock('counter', async () => {
            const seen = stored;
            await wait(5);
            stored = seen + 1;
        });

        await Promise.all(Array.from({ length: 20 }, increment));
        assert.strictEqual(stored, 20, 'an update was lost despite the lock');
    });

    test('a failing operation does not break the queue behind it', async () => {
        const h = locker();
        const done = [];
        const results = await Promise.allSettled([
            h.withKeyLock('k', async () => { throw new Error('boom'); }),
            h.withKeyLock('k', async () => { done.push('second'); return 'ok'; })
        ]);
        assert.strictEqual(results[0].status, 'rejected');
        assert.strictEqual(results[0].reason.message, 'boom');
        assert.strictEqual(results[1].status, 'fulfilled', 'the next waiter inherited the failure');
        assert.deepStrictEqual(done, ['second']);
    });

    test('the caller gets the return value and the error, unchanged', async () => {
        const h = locker();
        assert.strictEqual(await h.withKeyLock('k', async () => 42), 42);
        await assert.rejects(() => h.withKeyLock('k', async () => { throw new Error('nope'); }), /nope/);
    });

    test('the lock map does not grow one entry per key forever', async () => {
        const h = locker();
        for (let i = 0; i < 50; i++) {
            await h.withKeyLock(`key${i}`, async () => {});
        }
        assert.strictEqual(h._keyLocks.size, 0, 'lock entries leaked');
    });
});

describe('atomic write', () => {
    // The corruption came from a shorter write landing on a longer document and
    // leaving the old tail behind. A rename cannot do that: the target is replaced
    // whole or not at all.
    test('replacing a long document with a short one leaves no tail behind', async () => {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'deepjson-atomic-'));
        const target = path.join(dir, 'doc');

        const long = JSON.stringify({ value: 'x'.repeat(500) });
        const short = JSON.stringify({ value: 'y' });

        // Same sequence writeKeyData() performs.
        const writeAtomically = async (payload) => {
            const tmp = path.join(dir, `.doc.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
            await fsp.writeFile(tmp, payload);
            await fsp.rename(tmp, target);
        };

        await writeAtomically(long);
        await writeAtomically(short);

        const onDisk = await fsp.readFile(target, 'utf8');
        assert.strictEqual(onDisk, short, 'leftover bytes from the longer document survived');
        assert.doesNotThrow(() => JSON.parse(onDisk));
        assert.deepStrictEqual(fs.readdirSync(dir), ['doc'], 'a temp file was left behind');

        await fsp.rm(dir, { recursive: true, force: true });
    });
});
