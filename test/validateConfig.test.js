// Tests for validateConfig(), the startup check that rejects a broken
// dj.config / access.json before the server begins serving.
//
// The motivating case: script_engine is only read inside executeScript(), so a
// typo there used to let the server boot cleanly and then fail on the first
// script somebody ran, days later, looking like a script bug rather than a
// config typo. Everything checked here follows the same rule - if a value can
// only break at some unpredictable later moment, catch it at startup instead.
//
// Run with: node --test test/validateConfig.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

const validAccess = () => ({
    users: { alice: { id: 'alice', password: 'scrypt:aa:bb', groups: ['editors'] } },
    groups: { editors: { rules: [{ regex: '.*', crudx: '11110' }] } }
});

const validConfig = () => ({
    data_root: '/tmp/deepjson-test',
    access_file: '/tmp/deepjson-test/access.json',
    jwt_secret: 'x'.repeat(40),
    port: 8080,
    index_depth: 2
});

function validate(config, accessData = validAccess()) {
    const srv = Object.create(DeepJSONServer.prototype);
    srv.config = config;
    srv.accessData = accessData;
    return () => srv.validateConfig();
}

describe('validateConfig - dj.config', () => {
    test('a complete, valid config passes', () => {
        assert.doesNotThrow(validate(validConfig()));
    });

    test('an unknown script_engine is rejected at startup', () => {
        // "quickjs" is the library name, "wasm" is the engine name - an easy mix-up.
        assert.throws(validate({ ...validConfig(), script_engine: 'quickjs' }), /script_engine "quickjs" is unknown/);
    });

    test('a missing script_engine is fine and falls back to the default', () => {
        assert.doesNotThrow(validate(validConfig()));
    });

    test('every problem is reported at once, not one per restart', () => {
        const broken = { port: 99999, index_depth: 0, jwt_secret: '', script_engine: 'v8' };
        assert.throws(validate(broken), (err) => {
            assert.match(err.message, /6 problems/);
            assert.match(err.message, /data_root is required/);
            assert.match(err.message, /port must be an integer/);
            assert.match(err.message, /index_depth must be an integer/);
            assert.match(err.message, /script_engine "v8" is unknown/);
            return true;
        });
    });

    test('index_depth beyond the sha256 digest length is rejected', () => {
        // getKeyPath() slices two hex characters per level out of a 64-character
        // digest, so 32 is the hard ceiling.
        assert.doesNotThrow(validate({ ...validConfig(), index_depth: 32 }));
        assert.throws(validate({ ...validConfig(), index_depth: 33 }), /index_depth/);
    });

    test('with ssl enabled the certificate paths must exist', () => {
        const cfg = { ...validConfig(), ssl: { enabled: true, port: 8443, key: '/nope/key.pem', cert: '/nope/cert.pem' } };
        assert.throws(validate(cfg), /ssl\.key points to a file that does not exist/);
    });

    test('index_archiving.older_than_days must be a positive number', () => {
        const cfg = { ...validConfig(), index_archiving: { older_than_days: -5 } };
        assert.throws(validate(cfg), /older_than_days must be a positive number/);
    });

    test('byte-size limits accept size strings and plain byte counts', () => {
        assert.doesNotThrow(validate({ ...validConfig(), payload_limit: '50mb', text_payload_limit: '512kb' }));
        assert.doesNotThrow(validate({ ...validConfig(), text_payload_limit: 1048576 }));
        assert.doesNotThrow(validate(validConfig())); // both optional
    });

    test('a nonsensical byte-size limit is rejected', () => {
        assert.throws(validate({ ...validConfig(), text_payload_limit: '25 Bananen' }), /text_payload_limit must be a byte count/);
        assert.throws(validate({ ...validConfig(), text_payload_limit: 0 }), /must be a positive number of bytes/);
        assert.throws(validate({ ...validConfig(), payload_limit: 'viel' }), /payload_limit must be a byte count/);
    });
});

describe('getTextPayloadLimit', () => {
    // Guards the limit for text/* writes to /keys/:key. Without an explicit limit
    // express.text() silently falls back to body-parser's 100kb default, which is
    // well below payload_limit and caps the main key-write path.
    const limitFor = (config) => {
        const srv = Object.create(DeepJSONServer.prototype);
        srv.config = config;
        return srv.getTextPayloadLimit();
    };

    test('text_payload_limit wins when set', () => {
        assert.strictEqual(limitFor({ text_payload_limit: '25mb', payload_limit: '50mb' }), '25mb');
    });

    test('payload_limit applies when text_payload_limit is absent', () => {
        assert.strictEqual(limitFor({ payload_limit: '50mb' }), '50mb');
    });

    test('falls back to 10mb, the same default express.json() uses, never to 100kb', () => {
        assert.strictEqual(limitFor({}), '10mb');
    });
});

describe('validateConfig - access.json', () => {
    test('a user referencing an unknown group is rejected', () => {
        // checkPermissions() reads groups[group].rules directly, so this would be
        // a TypeError on that user's next request.
        const access = validAccess();
        access.users.alice.groups = ['does-not-exist'];
        assert.throws(validate(validConfig(), access), /references unknown group "does-not-exist"/);
    });

    test('a plaintext password is rejected', () => {
        const access = validAccess();
        access.users.alice.password = 'geheim123';
        assert.throws(validate(validConfig(), access), /not a scrypt hash/);
    });

    test('an invalid rule regex is caught before it can throw at request time', () => {
        const access = validAccess();
        access.groups.editors.rules = [{ regex: '[unclosed', crudx: '11110' }];
        assert.throws(validate(validConfig(), access), /invalid regex/);
    });

    test('a malformed crudx is rejected', () => {
        const access = validAccess();
        access.groups.editors.rules = [{ regex: '.*', crudx: '111' }];
        assert.throws(validate(validConfig(), access), /expected 5 characters/);
    });

    test('a bare JSON null in allowed_origins is caught, quoted "null" is accepted', () => {
        // The silent killer this check exists for: a JSON null still counts toward
        // the whitelist size, so the open-by-default fallback stays off while the
        // entry itself can never match, blocking every browser with no explanation.
        const broken = validAccess();
        broken.groups.editors.allowed_origins = [null, 'https://ok.example.com'];
        assert.throws(validate(validConfig(), broken), /allowed_origins\[0\] is null/);

        const quoted = validAccess();
        quoted.groups.editors.allowed_origins = ['null', 'https://ok.example.com'];
        assert.doesNotThrow(validate(validConfig(), quoted));
    });

    test('missing users or groups is rejected', () => {
        assert.throws(validate(validConfig(), { groups: {} }), /"users" is missing/);
        assert.throws(validate(validConfig(), { users: {} }), /"groups" is missing/);
    });
});
