// Tests for handleFileResponse()'s image-processing path (server.js), which is
// the app's only use of the `sharp` library: sharp(buffer).rotate().resize()
// plus optional format conversion.
//
// Written alongside the sharp 0.34.1 -> 0.35.4 upgrade (fixes GHSA-f88m-g3jw-g9cj,
// a set of high-severity libvips CVEs only patched from sharp 0.35.0 onward, a
// SemVer-major bump per npm). This path previously had no test coverage at all,
// so a behavior change in sharp's resize/rotate/encode API would have gone
// unnoticed. These tests exercise the real, installed sharp binary end to end
// (no mocking of sharp itself) to confirm the exact calls server.js makes still
// behave as expected after the upgrade.
//
// Run with: node --test test/handleFileResponse.test.js

const assert = require('node:assert');
const { test, describe } = require('node:test');
const sharp = require('sharp');
const DeepJSONServer = require('../server');

// A small real PNG, generated with sharp itself so the test needs no binary fixture.
async function makeTestPng({ width = 40, height = 20 } = {}) {
    return sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 200, g: 40, b: 40 }
        }
    }).png().toBuffer();
}

function makeFileData(buffer, { mimetype = 'image/png', filename = 'test.png' } = {}) {
    return {
        value: buffer.toString('base64'),
        _meta: { mimetype, filename }
    };
}

function makeRes(imageOptions = null) {
    return {
        locals: imageOptions ? { image: imageOptions } : {},
        statusCode: null,
        headers: {},
        body: null,
        set(headers) { Object.assign(this.headers, headers); return this; },
        status(code) { this.statusCode = code; return this; },
        send(payload) { this.body = payload; return this; }
    };
}

// handleFileResponse() calls this._isImage()/this._mapAlignment(), which live on
// the class prototype but touch no instance state, so a bare prototype-linked
// object is enough to run it standalone (same harness style as the other tests).
function run(fileData, res) {
    return DeepJSONServer.prototype.handleFileResponse.call(
        Object.create(DeepJSONServer.prototype), fileData, res, {}
    );
}

describe('handleFileResponse image processing (sharp)', () => {
    test('non-image content types are sent raw, without touching sharp', async () => {
        const buffer = Buffer.from('%PDF-1.4 not a real pdf');
        const fileData = makeFileData(buffer, { mimetype: 'application/pdf', filename: 'doc.pdf' });
        const res = makeRes();

        await run(fileData, res);

        assert.strictEqual(res.statusCode, null); // no error status set
        assert.strictEqual(res.headers['Content-Type'], 'application/pdf');
        assert.deepStrictEqual(res.body, buffer);
    });

    test('an image with no resize options is rotated and re-encoded via sharp', async () => {
        const png = await makeTestPng({ width: 40, height: 20 });
        const fileData = makeFileData(png);
        const res = makeRes(); // res.locals.image is undefined -> no resize/format requested

        await run(fileData, res);

        assert.strictEqual(res.statusCode, null);
        assert.ok(Buffer.isBuffer(res.body), 'response body should be a Buffer');

        const meta = await sharp(res.body).metadata();
        assert.strictEqual(meta.width, 40);
        assert.strictEqual(meta.height, 20);
    });

    test('width/height options resize the image via sharp .resize()', async () => {
        const png = await makeTestPng({ width: 100, height: 100 });
        const fileData = makeFileData(png);
        const res = makeRes({ width: 30, height: 20, fit: 'contain' });

        await run(fileData, res);

        assert.strictEqual(res.statusCode, null);
        const meta = await sharp(res.body).metadata();
        assert.strictEqual(meta.width, 30);
        assert.strictEqual(meta.height, 20);
    });

    test('fit "cover" with alignX/alignY exercises the alignment-mapped resize branch', async () => {
        const png = await makeTestPng({ width: 100, height: 50 });
        const fileData = makeFileData(png);
        const res = makeRes({ width: 20, height: 20, fit: 'cover', alignX: 'left', alignY: 'top' });

        await run(fileData, res);

        assert.strictEqual(res.statusCode, null);
        const meta = await sharp(res.body).metadata();
        assert.strictEqual(meta.width, 20);
        assert.strictEqual(meta.height, 20);
    });

    test('format "jpeg" converts the output and sets the matching Content-Type', async () => {
        const png = await makeTestPng();
        const fileData = makeFileData(png);
        const res = makeRes({ format: 'jpeg', quality: 70 });

        await run(fileData, res);

        assert.strictEqual(res.headers['Content-Type'], 'image/jpeg');
        const meta = await sharp(res.body).metadata();
        assert.strictEqual(meta.format, 'jpeg');
    });

    test('format "png" converts the output and sets the matching Content-Type', async () => {
        const png = await makeTestPng();
        const fileData = makeFileData(png, { mimetype: 'image/jpeg', filename: 'test.jpg' });
        const res = makeRes({ format: 'png', compressionLevel: 5 });

        await run(fileData, res);

        assert.strictEqual(res.headers['Content-Type'], 'image/png');
        const meta = await sharp(res.body).metadata();
        assert.strictEqual(meta.format, 'png');
    });

    test('corrupt image bytes are caught and answered with 500, not an unhandled rejection', async () => {
        const fileData = makeFileData(Buffer.from('this is not image data at all'));
        const res = makeRes();

        await run(fileData, res);

        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body, 'Failed to process image');
    });
});
