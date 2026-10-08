'use strict';

/**
 * A very small multipart/form-data reader, for the one thing this service needs it for: a plain
 * `<form enctype="multipart/form-data"><input type="file">` with no JavaScript at all.
 *
 * It streams. The file part goes straight to a temp file as it arrives (with sha256 and a byte count computed on
 * the way), so a 256 MB upload never sits in this process's memory; the text parts are small and are kept as
 * strings. It stops the moment the body passes `maxBytes` and answers { error: 'too_large' }.
 *
 * Nothing here decides what a form may contain: an unknown field comes back like any other, and the caller
 * validates what it uses. There is no dependency for this because there is none in this tree, and the one form
 * shape we accept is narrower than a general parser would be.
 */
const crypto = require('crypto');
const fs = require('fs');

const CRLF = '\r\n';
// A text field is a name or a choice: anything longer than this is not a form we serve, and it would sit in memory.
const FIELD_MAX = 64 * 1024;

/** The boundary of a multipart body, or null. */
function boundaryOf(contentType) {
    const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
    return m ? (m[1] || m[2]) : null;
}

/** name="x"; filename="y" from a part's Content-Disposition, or null. */
function disposition(line) {
    if (!/^content-disposition:/i.test(String(line || ''))) return null;
    const value = String(line).slice(String(line).indexOf(':') + 1);
    const get = (key) => {
        const v = new RegExp(`${key}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, 'i').exec(value);
        return v ? (v[1] !== undefined ? v[1] : v[2]) : null;
    };
    return { name: get('name'), filename: get('filename') };
}

/**
 * Read a multipart body. Answers
 *   { fields: { name: value }, file: { field, filename, contentType, path, size, sha256 } | null }
 * or { error, detail }. `filePath` is where the file part is written; the caller removes it.
 */
function readFormData(req, { boundary, filePath, maxBytes }) {
    return new Promise((resolve) => {
        const first = Buffer.from(`--${boundary}`);
        const delim = Buffer.from(`${CRLF}--${boundary}`);
        const fields = {};
        const hash = crypto.createHash('sha256');
        let state = 'preamble';
        let buf = Buffer.alloc(0);
        let sink = null;
        let part = null;
        let file = null;
        let settled = false;

        const removeTemp = () => { try { fs.unlinkSync(filePath); } catch { /* never created */ } };
        const finish = (out) => {
            if (settled) return;
            settled = true;
            req.removeListener('data', onData);
            resolve(out);
        };
        const fail = (error, detail) => {
            if (settled) return;
            if (sink) sink.destroy();
            removeTemp();
            req.removeListener('data', onData);
            req.resume();
            finish({ error, detail });
        };

        /** Everything before the boundary marker is the part's own bytes: count it, hash it, write it out. */
        const take = (data) => {
            if (!data || !data.length) return;
            if (!part || part.filename == null) {
                if (!part) part = { field: null, filename: null, contentType: null, data: [], size: 0 };
                part.size = (part.size || 0) + data.length;
                if (part.size > FIELD_MAX) return fail('bad_request', 'a form field is longer than this form takes');
                part.data.push(data);
                return;
            }
            if (!sink) {
                sink = fs.createWriteStream(filePath, { flags: 'w' });
                sink.on('error', (err) => fail('write_failed', (err && err.message) || 'the upload could not be written'));
            }
            file.size += data.length;
            hash.update(data);
            if (!sink.write(data)) { req.pause(); sink.once('drain', () => req.resume()); }
        };

        const endPart = () => {
            if (part && part.filename == null) {
                fields[part.field || ''] = Buffer.concat(part.data).toString('utf8');
            } else if (part) {
                file.field = part.field;
                file.filename = part.filename;
                file.contentType = part.contentType;
            }
            part = null;
        };

        const loop = () => {
            while (!settled) {
                if (state === 'preamble') {
                    const idx = buf.indexOf(first);
                    if (idx < 0) { buf = buf.subarray(Math.max(0, buf.length - first.length)); return; }
                    const after = buf.subarray(idx + first.length);
                    if (after.length < 2) { buf = after; return; }
                    buf = after.subarray(2);
                    state = after.subarray(0, 2).toString('latin1') === '--' ? 'done' : 'headers';
                    continue;
                }
                if (state === 'headers') {
                    const end = buf.indexOf('\r\n\r\n');
                    if (end < 0) {
                        if (buf.length > 16 * 1024) return fail('bad_request', 'the form part headers are too long');
                        return;
                    }
                    const block = buf.subarray(0, end).toString('utf8').split(CRLF);
                    const disp = disposition(block[0]);
                    const type = block.find((l) => /^content-type:/i.test(l));
                    part = {
                        field: disp && disp.name ? disp.name : null,
                        filename: disp && disp.filename != null ? disp.filename : null,
                        contentType: type ? type.slice(type.indexOf(':') + 1).trim() : null,
                        data: [],
                    };
                    if (part.filename != null) {
                        // One file per form: a second file part would otherwise be appended to the first.
                        if (file) return fail('bad_request', 'one file per upload');
                        file = { field: null, filename: null, contentType: null, path: filePath, size: 0 };
                    }
                    buf = buf.subarray(end + 4);
                    state = 'body';
                    continue;
                }
                if (state === 'body') {
                    const idx = buf.indexOf(delim);
                    if (idx < 0) {
                        const keep = Math.min(buf.length, delim.length - 1);
                        take(buf.subarray(0, buf.length - keep));
                        buf = buf.subarray(buf.length - keep);
                        return;
                    }
                    take(buf.subarray(0, idx));
                    const after = buf.subarray(idx + delim.length);
                    if (after.length < 2) { buf = after; return; }
                    const tail = after.subarray(0, 2).toString('latin1');
                    buf = after.subarray(2);
                    endPart();
                    state = tail === '--' ? 'done' : 'headers';
                    continue;
                }
                return;
            }
        };

        let collected = null;
        const collect = () => {
            if (!collected) {
                collected = { fields, file: null };
                if (file) collected.file = { ...file, sha256: hash.digest('hex') };
            }
            return collected;
        };

        // The sink is closed once, when the last boundary arrived. A body that ends before it is a cut-off upload,
        // not a shorter file: it is refused rather than stored truncated.
        let closing = false;
        const wrapUp = () => {
            if (closing || settled) return;
            if (state !== 'done') return fail('bad_request', 'the upload ended before the form did');
            closing = true;
            endPart();
            if (sink) sink.end(() => finish(collect()));
            else finish(collect());
        };

        let received = 0;
        function onData(chunk) {
            if (settled) return;
            received += chunk.length;
            if (received > maxBytes) return fail('too_large', 'larger than this service accepts in one request');
            buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
            loop();
            if (state === 'done') wrapUp();
        }

        req.on('data', onData);
        req.on('end', wrapUp);
        req.on('aborted', () => fail('aborted', 'the upload was interrupted'));
        req.on('error', () => fail('aborted', 'the upload was interrupted'));
    });
}

module.exports = { readFormData, boundaryOf };
