'use strict';
// Content labels on pictures (L1, 2026-10-31; Contracts 0.257.0 common.content-labels@1): the uploader labels a
// picture, the AI's `suggested` stays a suggestion until confirmed, every read carries the shape, and a label never
// hides the picture (the viewer's Network prefs decide).
//   node test/content-labels.test.js
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

const PICS = { Host: 'openvibe.pics' };
const SAME = { ...PICS, 'sec-fetch-site': 'same-origin' };

/** t.get with the Pics Host header (Node's fetch drops Host). */
function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { ...SAME, ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, text, json() { return JSON.parse(text); } });
            });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

(async () => {
    const t0 = await boot();
    const t = { ...t0, get: hostClient(t0) };
    const photo = () => sharp({ create: { width: 64, height: 48, channels: 3, background: '#335' } }).jpeg().toBuffer();
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const up = await t.get('/api/v1/images', { as: kim, method: 'POST', body: await photo(), headers: { ...SAME, 'content-type': 'image/jpeg' } });
        assert.strictEqual(up.status, 201, up.text);
        const slug = up.json().slug;
        const api = `/api/v1/images/${slug}`;

        await check('a picture is label-free by default, and the uploader sets labels', async () => {
            let r = await t.get(api, { as: kim });
            assert.deepStrictEqual(r.json().content_labels, { labels: [], suggested: [] });
            r = await t.get(api, { as: kim, method: 'PATCH', json: { labels: ['nudity', '18+'] } });
            assert.strictEqual(r.status, 200, r.text);
            assert.deepStrictEqual(r.json().content_labels, { labels: ['nudity', '18+'], suggested: [] });
            r = await t.get(api, { as: lee });
            assert.deepStrictEqual(r.json().content_labels, { labels: ['nudity', '18+'], suggested: [] }, 'anyone sees the labels on a public picture');
            assert.strictEqual(r.json().state, 'active', 'a label never hides the picture');
        });

        await check('a suggestion is stored as suggested and only the confirmed one leaves', async () => {
            await t.ctx.s.db.exec(`UPDATE pics_images SET content_labels = '{"labels":["18+"],"suggested":["nudity","language"]}' WHERE slug = $1`, [slug]);
            let r = await t.get(api, { as: kim });
            assert.deepStrictEqual(r.json().content_labels, { labels: ['18+'], suggested: ['nudity', 'language'] });
            r = await t.get(api, { as: kim, method: 'PATCH', json: { labels: ['18+', 'nudity'] } });
            assert.deepStrictEqual(r.json().content_labels, { labels: ['18+', 'nudity'], suggested: ['language'] }, 'confirming nudity keeps the unconfirmed language suggestion');
        });

        await check('unknown labels are refused, and only the uploader may set them', async () => {
            let r = await t.get(api, { as: kim, method: 'PATCH', json: { labels: ['gore'] } });
            assert.strictEqual(r.status, 422);
            assert.strictEqual(r.json().code, 'pics.labels_invalid');
            r = await t.get(api, { method: 'PATCH', json: { labels: ['nudity'] } });
            assert.ok([401, 403].includes(r.status), 'signed out cannot label');
            r = await t.get(api, { as: lee, method: 'PATCH', json: { labels: [] } });
            assert.ok([403, 404].includes(r.status), 'someone else cannot label it');
            r = await t.get(api, { as: kim });
            assert.deepStrictEqual(r.json().content_labels, { labels: ['18+', 'nudity'], suggested: ['language'] }, 'refusals changed nothing');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
