// Tests for conditional requests: ETag, If-Match and If-None-Match.
//
// Background: per-key locking serializes one request's read-script-write, but a
// client that reads, decides something, and writes in a *second* request can still
// be overtaken in between - the lock does not span two requests. If-Match carries
// the version the decision was based on, so the server can refuse a write whose
// basis has moved.
//
// The entity-tag comes from the document's own `_modCounter` rather than the
// server-global counter, because that value survives rebuild-index, a restore from
// backup and an index rotation. A rebuild renumbers the global counter, so an ETag
// built on it would quietly become wrong after a restore.
//
// Run with: node --test test/conditionalRequests.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const srv = () => Object.create(DeepJSONServer.prototype);
const headers = (h) => ({ headers: h });

describe('etagFor', () => {
    test('uses the document\'s own version counter, quoted', () => {
        assert.strictEqual(srv().etagFor({ _modCounter: 7 }), '"7"');
        assert.strictEqual(srv().etagFor({ _modCounter: 41 }), '"41"');
    });

    test('a freshly created document is version 0', () => {
        assert.strictEqual(srv().etagFor({ _modCounter: 0 }), '"0"');
        assert.strictEqual(srv().etagFor({}), '"0"');
        assert.strictEqual(srv().etagFor(undefined), '"0"');
    });
});

describe('etagMatches', () => {
    const m = (header, current) => srv().etagMatches(header, current);

    test('matches a correctly quoted tag', () => {
        assert.strictEqual(m('"7"', '"7"'), true);
        assert.strictEqual(m('"8"', '"7"'), false);
    });

    test('tolerates an unquoted tag, which clients send often enough', () => {
        assert.strictEqual(m('7', '"7"'), true);
        assert.strictEqual(m(' 7 ', '"7"'), true);
    });

    test('tolerates a weak validator prefix', () => {
        assert.strictEqual(m('W/"7"', '"7"'), true);
    });

    test('a comma-separated list is an OR, as the spec defines it', () => {
        assert.strictEqual(m('"6", "7", "8"', '"7"'), true);
        assert.strictEqual(m('"6", "8"', '"7"'), false);
    });

    test('"*" asks only whether the key exists', () => {
        assert.strictEqual(m('*', '"7"'), true);
        assert.strictEqual(m('*', '"0"'), true);
        assert.strictEqual(m('*', null), false);
    });

    test('nothing matches a key that does not exist', () => {
        assert.strictEqual(m('"7"', null), false);
        assert.strictEqual(m('"0"', null), false);
    });
});

describe('evaluatePreconditions', () => {
    const check = (h, current) => srv().evaluatePreconditions(headers(h), current);

    test('no conditional headers means no opinion', () => {
        assert.strictEqual(check({}, '"7"'), null);
        assert.strictEqual(check({}, null), null);
    });

    test('If-Match on the current version passes', () => {
        assert.strictEqual(check({ 'if-match': '"7"' }, '"7"'), null);
    });

    test('If-Match on a stale version fails with 412 and reports both sides', () => {
        const failed = check({ 'if-match': '"6"' }, '"7"');
        assert.strictEqual(failed.status, 412);
        assert.strictEqual(failed.error.expected, '"6"');
        assert.strictEqual(failed.error.current, '"7"');
        assert.match(failed.error.error, /has changed since the version supplied/);
    });

    test('If-Match on a missing key fails', () => {
        assert.strictEqual(check({ 'if-match': '"7"' }, null).status, 412);
        assert.strictEqual(check({ 'if-match': '*' }, null).status, 412);
    });

    test('If-Match: * passes when the key exists', () => {
        assert.strictEqual(check({ 'if-match': '*' }, '"3"'), null);
    });

    test('If-None-Match: * is the conditional create', () => {
        // absent -> proceed
        assert.strictEqual(check({ 'if-none-match': '*' }, null), null);
        // present -> refuse
        const failed = check({ 'if-none-match': '*' }, '"0"');
        assert.strictEqual(failed.status, 412);
        assert.strictEqual(failed.error.current, '"0"');
    });

    test('If-None-Match on a specific version refuses only on a match', () => {
        assert.strictEqual(check({ 'if-none-match': '"7"' }, '"7"').status, 412);
        assert.strictEqual(check({ 'if-none-match': '"6"' }, '"7"'), null);
    });

    test('If-Match takes precedence over If-None-Match', () => {
        // RFC 9110 13.2.2: If-None-Match is only consulted when If-Match is absent.
        // Here If-Match succeeds while If-None-Match would have refused.
        assert.strictEqual(
            check({ 'if-match': '"7"', 'if-none-match': '*' }, '"7"'),
            null
        );
        // And a failing If-Match still decides, even though If-None-Match would pass.
        assert.strictEqual(
            check({ 'if-match': '"6"', 'if-none-match': '"9"' }, '"7"').status,
            412
        );
    });
});
