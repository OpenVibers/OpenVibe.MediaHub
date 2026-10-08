'use strict';
/**
 * What the drive tests share: the same-origin header every signed-in write needs (a session-cookie write is only
 * accepted from openvibe.download itself), a chunked upload in one call, and small builders for a file and a share.
 */
const crypto = require('crypto');

const SAME = { 'sec-fetch-site': 'same-origin' };

/** Deterministic bytes of `n`: a pattern long enough to notice a wrong byte, and hashable. */
function bytes(n, seed = 'OpenVibe.MediaHub') {
    const out = Buffer.alloc(n);
    const block = Buffer.from(seed, 'utf8');
    for (let i = 0; i < n; i++) out[i] = block[i % block.length] ^ (i & 0xff);
    return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Upload through the API the way the page's script does: POST /files, one PUT per part, then complete.
 * Answers the final response (t.get's shape), so a caller can assert on it directly.
 */
async function upload(t, as, data, { name = 'file.bin', contentType = 'application/octet-stream', folder = null, onPart = null } = {}) {
    const started = await t.get('/api/v1/files', {
        as, headers: SAME,
        json: { name, size: data.length, content_type: contentType, folder_id: folder },
    });
    if (started.status !== 201 || !started.json().upload) return started;
    const up = started.json().upload;
    for (let n = 1; n <= up.parts_expected; n++) {
        const start = (n - 1) * up.part_size;
        const slice = data.subarray(start, Math.min(start + up.part_size, data.length));
        if (onPart) await onPart(n, up);
        const sent = await t.get(`/api/v1/uploads/${up.id}/parts/${n}`, {
            as, method: 'PUT', body: slice, headers: { ...SAME, 'content-type': 'application/octet-stream' },
        });
        if (sent.status !== 200) return sent;
    }
    return await t.get(`/api/v1/uploads/${up.id}/complete`, { as, json: {}, headers: SAME });
}

/** POST /api/v1/shares as somebody, same-origin by default. */
const share = (t, as, body, o = {}) => t.get('/api/v1/shares', { as, json: body, headers: { ...SAME, ...(o.headers || {}) } });

/**
 * The body a browser sends for `<form method=post enctype="multipart/form-data">` with a few text fields and one
 * file — what the no-JavaScript upload is. Returns { body, contentType } for t.get.
 */
function formBody(fields, file) {
    const boundary = `----ovtest${crypto.randomBytes(8).toString('hex')}`;
    const head = [];
    for (const [name, value] of Object.entries(fields || {})) {
        head.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    const fileHead = file ? [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`)] : [];
    const fileBytes = file ? [file.data, Buffer.from('\r\n')] : [];
    return {
        body: Buffer.concat([...head, ...fileHead, ...fileBytes, Buffer.from(`--${boundary}--\r\n`)]),
        contentType: `multipart/form-data; boundary=${boundary}`,
    };
}

/** POST the plain upload form (no JavaScript). */
const postForm = (t, as, fields, file, o = {}) => {
    const form = formBody(fields, file);
    return t.get('/files/upload', { as, body: form.body, headers: { ...SAME, 'content-type': form.contentType, ...(o.headers || {}) } });
};

module.exports = { SAME, bytes, sha256, upload, share, formBody, postForm };
