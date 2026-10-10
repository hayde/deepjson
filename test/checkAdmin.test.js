// Tests for checkAdmin(), the gate in front of every /admin/* route.
//
// Background: it used to grant admin to any group holding X on any rule, so a
// group scoped to a single key prefix with crudx "11111" got the full admin
// surface - /admin/keys, /admin/logs (seven days of request history across every
// client, unfiltered), rebuild-index, rotate-index and reload-access - without
// being in any admin group. Demonstrated with two users differing only in the
// fifth CRUDX character: the one with X got 200 on every admin route, the one
// without got 403.
//
// The rule now is group membership, nothing else. Execute is a permission on
// keys, not a role.
//
// Run with: node --test test/checkAdmin.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

function server(accessData) {
    const srv = Object.create(DeepJSONServer.prototype);
    srv.accessData = accessData;
    return srv;
}

// A group scoped to one prefix, with execute granted.
const scripterAccess = () => ({
    users: { dave: { id: 'dave', groups: ['scripter'] } },
    groups: { scripter: { rules: [{ regex: '^public\\..*', crudx: '11111' }] } }
});

describe('checkAdmin - who is an admin', () => {
    test('a member of "admin" is', () => {
        const srv = server({
            users: { a: { id: 'a', groups: ['admin'] } },
            groups: { admin: { rules: [] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'a' }), true);
    });

    test('a member of "superadmin" is', () => {
        const srv = server({
            users: { a: { id: 'a', groups: ['superadmin'] } },
            groups: { superadmin: { rules: [{ regex: '.*', crudx: '11111' }] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'a' }), true);
    });

    test('one admin group among several is enough', () => {
        const srv = server({
            users: { a: { id: 'a', groups: ['readonly', 'admin'] } },
            groups: { readonly: { rules: [{ regex: '.*', crudx: '01000' }] }, admin: { rules: [] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'a' }), true);
    });
});

describe('checkAdmin - execute is not a role', () => {
    test('a group with X on a scoped rule does NOT grant admin', () => {
        const srv = server(scripterAccess());
        assert.strictEqual(srv.checkAdmin({ id: 'dave' }), false,
            'execute permission must not confer admin');
    });

    test('a group with X on a catch-all rule still does NOT grant admin', () => {
        const srv = server({
            users: { dave: { id: 'dave', groups: ['scripter'] } },
            groups: { scripter: { rules: [{ regex: '.*', crudx: '11111' }] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'dave' }), false);
    });

    test('the legacy 4-character crud form does not grant admin either', () => {
        // checkPermissions() treats a missing crudx as "crud + implicit execute",
        // which is exactly the kind of accident that should not reach /admin.
        const srv = server({
            users: { dave: { id: 'dave', groups: ['legacy'] } },
            groups: { legacy: { rules: [{ regex: '.*', crud: '1111' }] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'dave' }), false);
    });

    test('a plain user without execute is not an admin', () => {
        const srv = server({
            users: { carol: { id: 'carol', groups: ['plainuser'] } },
            groups: { plainuser: { rules: [{ regex: '^public\\..*', crudx: '11110' }] } }
        });
        assert.strictEqual(srv.checkAdmin({ id: 'carol' }), false);
    });
});

describe('checkAdmin - malformed input is never an admin', () => {
    test('no user, no id, unknown id and no groups all return false', () => {
        const srv = server({
            users: { noGroups: { id: 'noGroups' } },
            groups: {}
        });

        assert.strictEqual(srv.checkAdmin(undefined), false);
        assert.strictEqual(srv.checkAdmin(null), false);
        assert.strictEqual(srv.checkAdmin({}), false);
        assert.strictEqual(srv.checkAdmin({ id: 'ghost' }), false);
        assert.strictEqual(srv.checkAdmin({ id: 'noGroups' }), false);
    });

    test('a group named in a user but absent from groups does not throw', () => {
        const srv = server({
            users: { a: { id: 'a', groups: ['missing'] } },
            groups: {}
        });
        assert.strictEqual(srv.checkAdmin({ id: 'a' }), false);
    });
});
