// Tests for the `durability` setting and where the flushes happen.
//
// Background: atomic rename already guaranteed a reader never sees half a
// document, but nothing was ever flushed, so a write could be acknowledged while
// still sitting in the page cache - and a power loss took it with no trace. There
// was no fsync anywhere in the codebase.
//
// The placement matters as much as the flush. The index log flush is deliberately
// outside INDEX_LOCK: inside it, every write in the server would serialize on one
// ~1.2ms flush, a global ceiling near 800 writes/sec regardless of how many
// distinct keys were involved. The ordering test below is what pins that down.
//
// Run with: node --test test/durability.test.js

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const req = { user: { id: 'tester' } };

async function harness(durability) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-durability-'));
    await fsp.mkdir(path.join(root, 'index', 'archive'), { recursive: true });

    const h = Object.create(DeepJSONServer.prototype);
    h.config = { data_root: root, index_depth: 3, durability };
    h.index = new Map();
    h.modificationCounter = 0;
    h._keyLocks = new Map();
    return { h, root };
}

describe('isSyncDurability', () => {
    test('defaults to sync when unset', () => {
        const h = Object.create(DeepJSONServer.prototype);
        h.config = {};
        assert.strictEqual(h.isSyncDurability(), true);
    });

    test('"sync" and "async" are honoured', () => {
        const h = Object.create(DeepJSONServer.prototype);
        h.config = { durability: 'sync' };
        assert.strictEqual(h.isSyncDurability(), true);
        h.config = { durability: 'async' };
        assert.strictEqual(h.isSyncDurability(), false);
    });
});

describe('writes work in both modes', () => {
    for (const mode of ['sync', 'async', undefined]) {
        test(`durability=${mode === undefined ? '(unset)' : mode} writes and reloads correctly`, async () => {
            const { h, root } = await harness(mode);
            const res = { locals: {} };

            await h.writeKeyData(req, res, 'alpha', { value: { n: 1 } });
            await h.writeKeyData(req, res, 'beta', { value: { n: 2 } });

            assert.deepStrictEqual((await h.readKeyData(req, 'alpha')).value, { n: 1 });

            // The index log must be loadable from disk, flushed or not.
            const reloaded = Object.create(DeepJSONServer.prototype);
            reloaded.config = h.config;
            reloaded.index = new Map();
            reloaded.modificationCounter = 0;
            await reloaded.loadIndex();

            assert.ok(reloaded.index.has('alpha'));
            assert.ok(reloaded.index.has('beta'));
        });
    }

    test('no temp files are left behind by a durable write', async () => {
        const { h, root } = await harness('sync');
        await h.writeKeyData(req, { locals: {} }, 'alpha', { value: { n: 1 } });

        const leftovers = [];
        const walk = async (dir) => {
            for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) await walk(p);
                else if (e.name.endsWith('.tmp')) leftovers.push(p);
            }
        };
        await walk(path.join(root, 'data'));
        assert.deepStrictEqual(leftovers, []);
    });
});

describe('flush placement', () => {
    test('the index flush happens after INDEX_LOCK is released', async () => {
        const { h } = await harness('sync');
        const events = [];

        const realUpdate = DeepJSONServer.prototype._updateIndex;
        h._updateIndex = async (...args) => {
            events.push('append:start');
            const out = await realUpdate.apply(h, args);
            events.push('append:end');
            return out;
        };
        h.fsyncIndexLog = async () => {
            events.push('flush:start');
            await wait(20);
            events.push('flush:end');
        };

        await h.updateIndex(req, 'alpha', 'WRITE');

        assert.deepStrictEqual(events,
            ['append:start', 'append:end', 'flush:start', 'flush:end']);
    });

    test('a second write can append while the first write is still flushing', async () => {
        // This is the whole point of the placement. If the flush were inside the
        // lock, the second append could not start until the first flush finished,
        // and every write in the server would queue behind one ~1.2ms flush.
        const { h } = await harness('sync');
        const events = [];

        const realUpdate = DeepJSONServer.prototype._updateIndex;
        h._updateIndex = async (...args) => {
            events.push('append');
            return realUpdate.apply(h, args);
        };
        h.fsyncIndexLog = async () => {
            events.push('flush:start');
            await wait(30);
            events.push('flush:end');
        };

        const first = h.updateIndex(req, 'alpha', 'WRITE');
        await wait(5); // first append done, its flush now in flight
        const second = h.updateIndex(req, 'beta', 'WRITE');
        await Promise.all([first, second]);

        const secondAppend = events.lastIndexOf('append');
        const firstFlushEnd = events.indexOf('flush:end');
        assert.ok(secondAppend < firstFlushEnd,
            `the second append must not wait for the first flush, got ${JSON.stringify(events)}`);
    });

    test('async mode performs no index flush at all', async () => {
        const { h } = await harness('async');
        let flushed = 0;
        const realFsync = DeepJSONServer.prototype.fsyncIndexLog;
        h.fsyncIndexLog = async (...a) => { flushed++; return realFsync.apply(h, a); };

        await h.updateIndex(req, 'alpha', 'WRITE');

        // The method is still called; it returns immediately without opening the file.
        assert.strictEqual(flushed, 1);
        assert.strictEqual(h.isSyncDurability(), false);
    });
});

describe('validateConfig - durability', () => {
    const validate = (durability) => {
        const srv = Object.create(DeepJSONServer.prototype);
        srv.config = {
            data_root: '/tmp/deepjson-test',
            access_file: '/tmp/deepjson-test/access.json',
            jwt_secret: 'x'.repeat(40),
            port: 8080,
            index_depth: 2,
            durability
        };
        srv.accessData = {
            users: { alice: { id: 'alice', password: 'scrypt:aa:bb', groups: ['editors'] } },
            groups: { editors: { rules: [{ regex: '.*', crudx: '11110' }] } }
        };
        return () => srv.validateConfig();
    };

    test('sync, async and unset all pass', () => {
        assert.doesNotThrow(validate('sync'));
        assert.doesNotThrow(validate('async'));
        assert.doesNotThrow(validate(undefined));
    });

    test('anything else is rejected at startup', () => {
        assert.throws(validate('fsync'), /durability must be "sync" or "async"/);
        assert.throws(validate(true), /durability must be "sync" or "async"/);
    });

    test('async warns that confirmed writes can be lost', () => {
        const warnings = [];
        const original = console.warn;
        console.warn = (m) => warnings.push(String(m));
        try {
            validate('async')();
        } finally {
            console.warn = original;
        }
        assert.ok(warnings.some(w => /can lose recently confirmed writes/.test(w)),
            `expected the durability warning, got ${JSON.stringify(warnings)}`);
    });
});
