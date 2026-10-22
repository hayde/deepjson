// Tests for index log compaction.
//
// Background: performIndexRotation() and cleanupIndexArchive() were both fully
// written but nothing ever called them, so the append-only index log grew without
// bound and the documented retention policy never ran. Making them reachable
// introduced a race worth guarding: updateIndex() appends to dj.index while
// rotation rewrites the same file from the in-memory index, and an append landing
// between rotation's snapshot and its write is present in memory but missing from
// the file - so it silently disappears at the next restart. Both now serialize
// through INDEX_LOCK.
//
// Run with: node --test test/indexRotation.test.js

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');
// Well-formed password hashes with no known password; these tests never log in.
const HASH_A = `scrypt:${'a'.repeat(32)}:${'b'.repeat(128)}`;

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const req = { user: { id: 'tester' } };

async function harness(indexArchiving = undefined) {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-rotate-'));
    await fsp.mkdir(path.join(root, 'index', 'archive'), { recursive: true });

    const h = Object.create(DeepJSONServer.prototype);
    h.config = { data_root: root, index_depth: 3, index_archiving: indexArchiving };
    h.index = new Map();
    h.modificationCounter = 0;
    h._keyLocks = new Map();
    return { h, root };
}

const indexLines = async (root) => {
    const raw = await fsp.readFile(path.join(root, 'index', 'dj.index'), 'utf8');
    return raw.split('\n').filter(l => l.trim());
};

describe('performIndexRotation', () => {
    test('compacts repeated writes of one key down to a single line', async () => {
        const { h, root } = await harness();

        for (let i = 0; i < 5; i++) await h.updateIndex(req, 'reports.q3', 'WRITE');
        assert.strictEqual((await indexLines(root)).length, 5, 'every write should append a line');

        const result = await h.performIndexRotation();

        const lines = await indexLines(root);
        assert.strictEqual(lines.length, 1, 'rotation should leave one line per live key');
        assert.ok(lines[0].startsWith('reports.q3|'));
        assert.strictEqual(result.keys, 1);
        assert.ok(result.bytesAfter < result.bytesBefore, 'the log should get smaller');
    });

    test('drops DELETE tombstones for keys that no longer exist', async () => {
        const { h, root } = await harness();

        await h.updateIndex(req, 'a', 'WRITE');
        await h.updateIndex(req, 'b', 'WRITE');
        await h.updateIndex(req, 'a', 'DELETE');

        await h.performIndexRotation();

        const lines = await indexLines(root);
        assert.strictEqual(lines.length, 1);
        assert.ok(lines[0].startsWith('b|'), 'only the surviving key should remain');
    });

    test('writes a dated archive snapshot that carries modCount', async () => {
        const { h, root } = await harness();
        await h.updateIndex(req, 'k', 'WRITE');

        const result = await h.performIndexRotation();

        const snapshot = await fsp.readFile(result.archive, 'utf8');
        const fields = snapshot.split('\n')[0].split('|');
        assert.strictEqual(fields.length, 5, 'snapshot must include modCount, or it cannot restore the counter');
        assert.strictEqual(fields[0], 'k');
        assert.strictEqual(Number(fields[4]), h.index.get('k').modCount);
    });

    test('leaves no temp file behind', async () => {
        const { h, root } = await harness();
        await h.updateIndex(req, 'k', 'WRITE');
        await h.performIndexRotation();

        const leftovers = (await fsp.readdir(path.join(root, 'index')))
            .filter(f => f.endsWith('.tmp'));
        assert.deepStrictEqual(leftovers, []);
    });

    test('a rotated index reloads with every key and modCount intact', async () => {
        const { h, root } = await harness();

        await h.updateIndex(req, 'one', 'WRITE');
        await h.updateIndex(req, 'two', 'WRITE');
        await h.performIndexRotation();
        // Writes after a rotation append to the compacted file.
        await h.updateIndex(req, 'three', 'WRITE');
        await h.updateIndex(req, 'one', 'WRITE');

        const expected = new Map([...h.index].map(([k, v]) => [k, v.modCount]));

        const reloaded = Object.create(DeepJSONServer.prototype);
        reloaded.config = h.config;
        reloaded.index = new Map();
        reloaded.modificationCounter = 0;
        await reloaded.loadIndex();

        assert.deepStrictEqual(
            new Map([...reloaded.index].map(([k, v]) => [k, v.modCount])),
            expected
        );
        assert.strictEqual(reloaded.modificationCounter, h.modificationCounter);
    });
});

describe('index log mutual exclusion', () => {
    test('an append cannot interleave with a rotation', async () => {
        const { h } = await harness();
        await h.updateIndex(req, 'existing', 'WRITE');

        const events = [];
        // Stretch the rotation so an append has a real chance to slip in, and mark
        // its first and last step from inside the locked section.
        h.saveIndexSnapshot = async () => { events.push('rotate:start'); await wait(40); };
        h.cleanupIndexArchive = async () => { events.push('rotate:end'); return 0; };

        const realUpdate = DeepJSONServer.prototype._updateIndex;
        h._updateIndex = async (...args) => {
            events.push('append:start');
            return realUpdate.apply(h, args);
        };

        const rotating = h.performIndexRotation();
        await wait(5); // let rotation take the lock first
        const appending = h.updateIndex(req, 'during', 'WRITE');
        await Promise.all([rotating, appending]);

        assert.deepStrictEqual(events, ['rotate:start', 'rotate:end', 'append:start'],
            'the append must wait for the whole rotation, not land inside it');
    });

    test('a write issued during a rotation survives a reload', async () => {
        const { h, root } = await harness();
        await h.updateIndex(req, 'existing', 'WRITE');

        const realSnapshot = DeepJSONServer.prototype.saveIndexSnapshot;
        h.saveIndexSnapshot = async () => { await wait(30); return realSnapshot.call(h); };

        const rotating = h.performIndexRotation();
        await wait(5);
        await Promise.all([rotating, h.updateIndex(req, 'during', 'WRITE')]);

        const reloaded = Object.create(DeepJSONServer.prototype);
        reloaded.config = h.config;
        reloaded.index = new Map();
        reloaded.modificationCounter = 0;
        await reloaded.loadIndex();

        assert.ok(reloaded.index.has('during'), 'the concurrent write must be in the file, not only in memory');
        assert.ok(reloaded.index.has('existing'));
    });
});

describe('archive retention', () => {
    test('removes snapshots older than older_than_days and reports the count', async () => {
        const { h, root } = await harness({ older_than_days: 5 });
        const archiveDir = path.join(root, 'index', 'archive');

        const stamp = (daysAgo) => {
            const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
            return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
        };
        await fsp.writeFile(path.join(archiveDir, `dj.index.${stamp(30)}`), 'old');
        await fsp.writeFile(path.join(archiveDir, `dj.index.${stamp(10)}`), 'old');
        await fsp.writeFile(path.join(archiveDir, `dj.index.${stamp(1)}`), 'recent');
        await fsp.writeFile(path.join(archiveDir, 'unrelated.txt'), 'keep me');

        await h.updateIndex(req, 'k', 'WRITE');
        const result = await h.performIndexRotation();

        assert.strictEqual(result.archivesRemoved, 2);
        const left = (await fsp.readdir(archiveDir)).sort();
        assert.ok(left.includes(`dj.index.${stamp(1)}`), 'a recent snapshot must survive');
        assert.ok(left.includes(path.basename(result.archive)), "today's snapshot must survive");
        assert.ok(left.includes('unrelated.txt'), 'files outside the naming scheme are left alone');
    });

    test('does nothing when index_archiving is absent', async () => {
        const { h } = await harness();
        await h.updateIndex(req, 'k', 'WRITE');
        const result = await h.performIndexRotation();
        assert.strictEqual(result.archivesRemoved, 0);
    });
});

describe('startIndexRotationSchedule', () => {
    test('stays off unless rotate_every_hours is configured', async () => {
        const { h } = await harness({ older_than_days: 5 });
        assert.strictEqual(h.startIndexRotationSchedule(), null);
        assert.strictEqual(h._indexRotationTimer, undefined);
    });

    test('schedules when configured, and does not hold the process open', async () => {
        const { h } = await harness({ rotate_every_hours: 24 });
        const timer = h.startIndexRotationSchedule();
        try {
            assert.ok(timer, 'a timer should be created');
            assert.strictEqual(timer.hasRef(), false, 'the timer must be unref()d');
        } finally {
            clearInterval(timer);
        }
    });
});

describe('validateConfig - rotate_every_hours', () => {
    const base = (indexArchiving) => {
        const srv = Object.create(DeepJSONServer.prototype);
        srv.config = {
            data_root: '/tmp/deepjson-test',
            access_file: '/tmp/deepjson-test/access.json',
            jwt_secret: 'x'.repeat(40),
            port: 8080,
            index_depth: 2,
            index_archiving: indexArchiving
        };
        srv.accessData = {
            users: { alice: { id: 'alice', password: HASH_A, groups: ['editors'] } },
            groups: { editors: { rules: [{ regex: '.*', crudx: '11110' }] } }
        };
        return () => srv.validateConfig();
    };

    test('accepts a positive number of hours', () => {
        assert.doesNotThrow(base({ rotate_every_hours: 24, older_than_days: 30 }));
    });

    test('rejects a non-positive value at startup', () => {
        assert.throws(base({ rotate_every_hours: 0 }), /rotate_every_hours must be a positive number of hours/);
        assert.throws(base({ rotate_every_hours: 'daily' }), /rotate_every_hours must be a positive number of hours/);
    });

    test('warns when retention is configured without a schedule to run it', () => {
        const warnings = [];
        const original = console.warn;
        console.warn = (msg) => warnings.push(String(msg));
        try {
            base({ older_than_days: 30 })();
        } finally {
            console.warn = original;
        }
        assert.ok(
            warnings.some(w => /rotate_every_hours is not/.test(w)),
            `expected a warning about retention never running, got: ${JSON.stringify(warnings)}`
        );
    });
});
