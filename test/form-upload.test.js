'use strict';
/**
 * The no-JavaScript upload form's reader (server/http/form-upload.js): a file streams to disk with its hash, and the
 * forms it refuses — a text field too long to hold, a second file, a body cut off before its last boundary.
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { readFormData } = require('../server/http/form-upload');

const BOUNDARY = 'xYzBoundary123';
const tmp = (n) => path.join(os.tmpdir(), `mh-form-${process.pid}-${n}`);

function body(parts, { close = true } = {}) {
    const chunks = [];
    for (const p of parts) {
        chunks.push(Buffer.from(`--${BOUNDARY}\r\n`));
        const disp = p.filename != null ? `form-data; name="${p.name}"; filename="${p.filename}"` : `form-data; name="${p.name}"`;
        chunks.push(Buffer.from(`Content-Disposition: ${disp}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ''}\r\n`));
        chunks.push(Buffer.isBuffer(p.value) ? p.value : Buffer.from(p.value));
        chunks.push(Buffer.from('\r\n'));
    }
    if (close) chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(chunks);
}

/** Feed a body in small chunks, as a socket would, and read it. */
async function read(buf, n) {
    const req = new PassThrough();
    const out = readFormData(req, { boundary: BOUNDARY, filePath: tmp(n), maxBytes: 10 * 1024 * 1024 });
    for (let i = 0; i < buf.length; i += 4096) req.write(buf.subarray(i, i + 4096));
    req.end();
    return out;
}

(async () => {
    const data = crypto.randomBytes(200_000);
    let r = await read(body([{ name: 'folder', value: 'fld_1' }, { name: 'file', filename: 'photo.png', type: 'image/png', value: data }]), 1);
    assert.ok(!r.error, JSON.stringify(r));
    assert.strictEqual(r.fields.folder, 'fld_1');
    assert.strictEqual(r.file.filename, 'photo.png');
    assert.strictEqual(r.file.size, data.length);
    assert.strictEqual(r.file.sha256, crypto.createHash('sha256').update(data).digest('hex'));
    assert.ok(fs.readFileSync(r.file.path).equals(data), 'the bytes on disk are the bytes sent');
    fs.unlinkSync(r.file.path);

    r = await read(body([{ name: 'note', value: 'x'.repeat(70 * 1024) }]), 2);
    assert.strictEqual(r.error, 'bad_request', 'a text field past 64 KB is refused, not held in memory');

    r = await read(body([{ name: 'a', filename: 'one.bin', value: 'one' }, { name: 'b', filename: 'two.bin', value: 'two' }]), 3);
    assert.strictEqual(r.error, 'bad_request', 'a second file is refused, not appended to the first');
    assert.ok(!fs.existsSync(tmp(3)), 'and nothing is left on disk');

    r = await read(body([{ name: 'file', filename: 'cut.bin', value: data }], { close: false }), 4);
    assert.strictEqual(r.error, 'bad_request', 'a body cut off before its last boundary is not stored as a shorter file');
    assert.ok(!fs.existsSync(tmp(4)));

    console.log('form-upload: ok');
})().catch((err) => { console.error(err); process.exit(1); });
