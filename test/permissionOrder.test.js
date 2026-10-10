// Tests for the cross-group revocation warning.
//
// Background: checkPermissions() reassigns its verdict on every matching rule, so
// the last match decides - and it walks groups in whatever order `user.groups`
// lists them. Within one group that ordering is a documented idiom: grant a prefix,
// then deny a narrower one underneath. Across groups it is a trap, because the
// order comes from an arbitrary JSON array, so adding a group to a user can quietly
// revoke access they already had.
//
// The check reports only the cross-group case. Flagging the idiom too would make it
// noise, and `/whoami` already exposes `rulesAreAdvisory: true` for anyone who
// thinks to look - the point of this warning is that nobody does.
//
// Run with: node --test test/permissionOrder.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

function harness(users, groups, keys) {
    const h = Object.create(DeepJSONServer.prototype);
    h.accessData = { users, groups };
    h.index = new Map(keys.map(k => [k, {}]));
    return h;
}

const ALL = '11111';

describe('what is reported', () => {
    test('a later group revoking an earlier group\'s grant is reported', () => {
        const h = harness(
            { m1x: { id: 'm1x', groups: ['worker', 'readonly'] } },
            {
                worker: { rules: [{ regex: '^de\\..*', crudx: ALL }] },
                readonly: { rules: [{ regex: '^de\\.kreuzer\\..*', crudx: '01000' }] }
            },
            ['de.alpha.doc.1', 'de.kreuzer.doc.1', 'de.kreuzer.doc.2']
        );

        const [finding] = h.findCrossGroupRevocations();
        assert.strictEqual(finding.userId, 'm1x');
        // readonly keeps R, so only the other four are taken away.
        assert.deepStrictEqual([...finding.counts.entries()].sort(),
            [['C', 2], ['D', 2], ['U', 2], ['X', 2]]);
        assert.strictEqual(finding.counts.get('R'), undefined, 'R is granted by both, so it is not revoked');
    });

    test('the example names both sides, so the warning is actionable', () => {
        const h = harness(
            { u: { id: 'u', groups: ['wide', 'narrow'] } },
            {
                wide: { rules: [{ regex: '^a\\..*', crudx: ALL }] },
                narrow: { rules: [{ regex: '^a\\.b\\..*', crudx: '00000' }] }
            },
            ['a.b.key']
        );

        const { example } = h.findCrossGroupRevocations()[0];
        assert.strictEqual(example.key, 'a.b.key');
        assert.strictEqual(example.grantedBy.group, 'wide');
        assert.strictEqual(example.revokedBy.group, 'narrow');
    });

    test('group order decides, which is the whole hazard', () => {
        const groups = {
            wide: { rules: [{ regex: '^a\\..*', crudx: ALL }] },
            narrow: { rules: [{ regex: '^a\\.b\\..*', crudx: '00000' }] }
        };
        const keys = ['a.b.key'];

        const revoked = harness({ u: { id: 'u', groups: ['wide', 'narrow'] } }, groups, keys);
        const granted = harness({ u: { id: 'u', groups: ['narrow', 'wide'] } }, groups, keys);

        assert.strictEqual(revoked.findCrossGroupRevocations().length, 1);
        assert.strictEqual(granted.findCrossGroupRevocations().length, 0,
            'reversed, the wide grant lands last and nothing is revoked');
        // And the server really does resolve them differently.
        assert.strictEqual(revoked.checkPermissions({ id: 'u' }, 'a.b.key', 'R'), false);
        assert.strictEqual(granted.checkPermissions({ id: 'u' }, 'a.b.key', 'R'), true);
    });

    test('each affected user is reported separately', () => {
        const h = harness(
            {
                a: { id: 'a', groups: ['wide', 'narrow'] },
                b: { id: 'b', groups: ['wide'] },
                c: { id: 'c', groups: ['wide', 'narrow'] }
            },
            {
                wide: { rules: [{ regex: '^k\\..*', crudx: ALL }] },
                narrow: { rules: [{ regex: '^k\\..*', crudx: '00000' }] }
            },
            ['k.1']
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations().map(f => f.userId), ['a', 'c']);
    });
});

describe('what is deliberately NOT reported', () => {
    test('the documented within-group idiom stays silent', () => {
        // Straight from examples/access.json.example: grant a prefix, deny a
        // narrower one beneath it. Intentional, and not order-fragile.
        const h = harness(
            { alice: { id: 'alice', groups: ['editors'] } },
            {
                editors: {
                    rules: [
                        { regex: '^reports\\..*', crudx: '11110' },
                        { regex: '^reports\\.locked\\..*', crudx: '01000' }
                    ]
                }
            },
            ['reports.q3', 'reports.locked.q2']
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations(), []);
    });

    test('a single group is never reported, however many rules it has', () => {
        const h = harness(
            { u: { id: 'u', groups: ['only'] } },
            { only: { rules: [{ regex: '.*', crudx: ALL }, { regex: '^x\\..*', crudx: '00000' }] } },
            ['x.1', 'y.1']
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations(), []);
    });

    test('non-overlapping groups are not reported', () => {
        const h = harness(
            { u: { id: 'u', groups: ['a', 'b'] } },
            {
                a: { rules: [{ regex: '^a\\..*', crudx: ALL }] },
                b: { rules: [{ regex: '^b\\..*', crudx: '00000' }] }
            },
            ['a.1', 'b.1']
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations(), []);
    });

    test('a rule with neither crudx nor crud cannot revoke, since it never decides', () => {
        const h = harness(
            { u: { id: 'u', groups: ['wide', 'inert'] } },
            {
                wide: { rules: [{ regex: '^k\\..*', crudx: ALL }] },
                inert: { rules: [{ regex: '^k\\..*' }] }
            },
            ['k.1']
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations(), []);
        assert.strictEqual(h.checkPermissions({ id: 'u' }, 'k.1', 'R'), true,
            'and the permission really does survive');
    });

    test('an empty index reports nothing, so a fresh install is quiet', () => {
        const h = harness(
            { u: { id: 'u', groups: ['wide', 'narrow'] } },
            {
                wide: { rules: [{ regex: '.*', crudx: ALL }] },
                narrow: { rules: [{ regex: '.*', crudx: '00000' }] }
            },
            []
        );
        assert.deepStrictEqual(h.findCrossGroupRevocations(), []);
    });
});

describe('robustness and cost', () => {
    test('the legacy 4-character crud form is handled', () => {
        // checkPermissions() treats a missing crudx as crud plus implicit execute.
        const h = harness(
            { u: { id: 'u', groups: ['wide', 'narrow'] } },
            {
                wide: { rules: [{ regex: '^k\\..*', crudx: ALL }] },
                narrow: { rules: [{ regex: '^k\\..*', crud: '0100' }] }
            },
            ['k.1']
        );
        const [finding] = h.findCrossGroupRevocations();
        // crud "0100" becomes "01001": R kept, X kept, C/U/D revoked.
        assert.deepStrictEqual([...finding.counts.keys()].sort(), ['C', 'D', 'U']);
    });

    test('the scan is capped and says when it sampled', () => {
        const keys = Array.from({ length: 200 }, (_, i) => `k.${i}`);
        const h = harness(
            { u: { id: 'u', groups: ['wide', 'narrow'] } },
            {
                wide: { rules: [{ regex: '^k\\..*', crudx: ALL }] },
                narrow: { rules: [{ regex: '^k\\..*', crudx: '00000' }] }
            },
            keys
        );

        const capped = h.findCrossGroupRevocations({ limit: 50 })[0];
        assert.strictEqual(capped.scanned, 50);
        assert.strictEqual(capped.sampled, true);
        assert.strictEqual(capped.counts.get('R'), 50);

        const full = h.findCrossGroupRevocations()[0];
        assert.strictEqual(full.sampled, false);
        assert.strictEqual(full.counts.get('R'), 200);
    });

    test('the warning is printed once per affected user', () => {
        const h = harness(
            {
                a: { id: 'a', groups: ['wide', 'narrow'] },
                b: { id: 'b', groups: ['wide', 'narrow'] }
            },
            {
                wide: { rules: [{ regex: '^k\\..*', crudx: ALL }] },
                narrow: { rules: [{ regex: '^k\\..*', crudx: '00000' }] }
            },
            ['k.1']
        );

        const warnings = [];
        const original = console.warn;
        console.warn = (m) => warnings.push(String(m));
        try {
            h.warnAboutCrossGroupRevocations();
        } finally {
            console.warn = original;
        }

        assert.strictEqual(warnings.length, 2);
        assert.ok(warnings.every(w => /Permission warning: user/.test(w)));
        assert.ok(warnings.some(w => /granted by group "wide"/.test(w) && /denied by group "narrow"/.test(w)));
        assert.ok(warnings.every(w => /whoami/.test(w)), 'point the operator at the authoritative check');
    });
});
