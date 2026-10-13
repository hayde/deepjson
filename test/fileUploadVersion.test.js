// Tests that re-uploading a file advances the document's version and preserves its
// metadata.
//
// Background: the file-upload branch of _handleKeyRequest() passed a placeholder
// *string* as the record to write, on the reasoning that writeKeyData() fills in the
// file itself. But writeKeyData() decides new-versus-existing by looking for `_key`
// on what it is handed, and a string has none - so every upload took the "brand new
// record" branch. `_modCounter` went back to 0, `_created` was reset, and `custom`
// was dropped.
//
// That surfaced as a caching bug once ETags were derived from `_modCounter`: a
// browser holding ETag "0" was told 304 for every later version of the document, so
// a replaced PDF was served from cache indefinitely. Fixing the 304 handling alone
// would have turned a visible error into silent staleness, which is worse.
//
// Run with: node --test test/fileUploadVersion.test.js

const assert = require('node:assert');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test, describe } = require('node:test');
const DeepJSONServer = require('../server');

async function harness() {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dj-upload-'));
    await fsp.mkdir(path.join(root, 'index', 'archive'), { recursive: true });

    const h = Object.create(DeepJSONServer.prototype);
    h.config = { data_root: root, index_depth: 3 };
    h.index = new Map();
    h.modificationCounter = 0;
    h._keyLocks = new Map();
    return h;
}

// What express-fileupload leaves on the request.
const upload = (contents, name = 'doc.pdf') => ({
    user: { id: 'tester' },
    files: {
        file: {
            name,
            mimetype: 'application/pdf',
            data: Buffer.from(contents),
            size: Buffer.byteLength(contents),
            md5: 'ignored-here'
        }
    }
});
const uploadRes = () => ({ locals: { fileUpload: true } });

describe('re-uploading a file advances the version', () => {
    test('the first upload is version 0 and each replacement increments', async () => {
        const h = await harness();

        // _handleKeyRequest passes the existing record, or {} when the key is new.
        const first = await h.writeKeyData(upload('v1'), uploadRes(), 'f.pdf', {});
        assert.strictEqual(first._modCounter, 0);

        const second = await h.writeKeyData(upload('v2'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload('v2'), 'f.pdf'));
        assert.strictEqual(second._modCounter, 1, 'a replacement must not reset the version');

        const third = await h.writeKeyData(upload('v3'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload('v3'), 'f.pdf'));
        assert.strictEqual(third._modCounter, 2);
    });

    test('the ETag therefore changes, which is what makes caching correct', async () => {
        const h = await harness();

        await h.writeKeyData(upload('v1'), uploadRes(), 'f.pdf', {});
        const before = h.etagFor(await h.readKeyData(upload(''), 'f.pdf'));

        await h.writeKeyData(upload('v2'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload(''), 'f.pdf'));
        const after = h.etagFor(await h.readKeyData(upload(''), 'f.pdf'));

        assert.notStrictEqual(before, after,
            'an unchanged ETag means a browser serves the old file forever');
        assert.strictEqual(before, '"0"');
        assert.strictEqual(after, '"1"');
    });

    test('the new contents really are stored', async () => {
        const h = await harness();
        await h.writeKeyData(upload('first version'), uploadRes(), 'f.pdf', {});
        await h.writeKeyData(upload('second version'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload(''), 'f.pdf'));

        const stored = await h.readKeyData(upload(''), 'f.pdf');
        assert.strictEqual(Buffer.from(stored.value, 'base64').toString(), 'second version');
    });
});

describe('a replacement preserves what it should', () => {
    test('custom metadata survives a re-upload', async () => {
        const h = await harness();
        await h.writeKeyData(upload('v1'), uploadRes(), 'f.pdf', {});

        // Metadata attached after the upload, as the scanner flow does.
        const withMeta = await h.readKeyData(upload(''), 'f.pdf');
        withMeta.custom = { scanner: { boxNumber: 7, batch: 'b-1' } };
        await h.writeKeyData({ user: { id: 'tester' } }, { locals: {} }, 'f.pdf', withMeta);

        // Now replace the file itself.
        await h.writeKeyData(upload('v2'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload(''), 'f.pdf'));

        const stored = await h.readKeyData(upload(''), 'f.pdf');
        assert.deepStrictEqual(stored.custom, { scanner: { boxNumber: 7, batch: 'b-1' } },
            'replacing the file must not discard the metadata attached to it');
    });

    test('the creation timestamp is not reset by a replacement', async () => {
        const h = await harness();
        const first = await h.writeKeyData(upload('v1'), uploadRes(), 'f.pdf', {});
        const created = first._created;

        await new Promise(r => setTimeout(r, 5));
        const second = await h.writeKeyData(upload('v2'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload(''), 'f.pdf'));

        assert.strictEqual(second._created, created, '_created belongs to the key, not the file');
        assert.ok(second._modification, '_modification should be set on a replacement');
    });

    test('file metadata is refreshed for the new file', async () => {
        const h = await harness();
        await h.writeKeyData(upload('short', 'a.pdf'), uploadRes(), 'f.pdf', {});
        await h.writeKeyData(upload('a much longer body', 'b.pdf'), uploadRes(), 'f.pdf',
            await h.readKeyData(upload(''), 'f.pdf'));

        const stored = await h.readKeyData(upload(''), 'f.pdf');
        assert.strictEqual(stored._meta.filename, 'b.pdf');
        assert.strictEqual(stored._meta.size, Buffer.from('a much longer body').length);
        assert.strictEqual(stored._type, 'file');
    });
});
