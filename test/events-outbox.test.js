'use strict';
/**
 * MediaHub's own events (server/events-outbox.js, contracts 0.196.0): a signed-in person's picture writes
 * mediahub.picture.uploaded (internal, no link or title) with the row, a signed-out one writes nothing; an upload's first
 * time public and ready writes mediahub.video.published once (private and public again does not repeat it), and only
 * then; every envelope is valid (source media-hub, namespace mediahub.*).
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');

function picsClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', 'sec-fetch-site': 'same-origin', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        const body = o.body;
        if (body != null) headers['content-length'] = String(body.length);
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: o.method || 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

(async () => {
    const t0 = await boot({ env: { MEDIAHUB_PICS_ANONYMOUS: '1', MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    const t = { ...t0, get: picsClient(t0) };
    const s = t0.ctx.s;
    const rows = async (type) => (await s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => (typeof r.envelope === 'string' ? JSON.parse(r.envelope) : r.envelope)).filter((e) => !type || e.event_type === type);
    try {
        const kim = t0.network.addUser('kim');
        const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3a6' } }).jpeg().toBuffer();

        await check('a signed-in picture writes mediahub.picture.uploaded with the row; a signed-out one writes nothing', async () => {
            const r = await t.get('/api/v1/images', { as: kim, method: 'POST', body: jpeg, headers: { 'content-type': 'image/jpeg', 'x-title': 'secret%20title' } });
            assert.strictEqual(r.status, 201, r.text);
            const pic = r.json();
            const ev = await rows('mediahub.picture.uploaded');
            assert.strictEqual(ev.length, 1);
            const e = ev[0];
            assert.ok(validate('events.event-envelope@1', e).valid, JSON.stringify(validate('events.event-envelope@1', e).errors));
            assert.ok(validate('mediahub.picture.uploaded@1', e.payload).valid);
            assert.deepStrictEqual([e.source, e.visibility, e.subject, e.actor], ['media-hub', 'internal', { type: 'picture', id: pic.id }, { type: 'user', id: kim.subject }]);
            assert.ok(!JSON.stringify(e).includes(pic.slug) && !JSON.stringify(e).includes('secret title'), 'no link and no title');
            const anon = await t.get('/api/v1/images', { method: 'POST', body: jpeg, headers: { 'content-type': 'image/jpeg' } });
            assert.strictEqual(anon.status, 201, anon.text);
            assert.strictEqual((await rows('mediahub.picture.uploaded')).length, 1, 'still one');
        });

        await check('an upload\'s first time public and ready writes mediahub.video.published once', async () => {
            const up = t0.ctx.videoUploads;
            const ins = (id, visibility) => s.db.exec(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at)
                VALUES ($1, $2, 'kim', 'A walk on the coast', '', $3, 1, 'video/mp4', 10, 10, 1, 1, 'ready', 'active', $4, $4, $4)`, [id, `user:${kim.subject}`, visibility, s.iso()]);
            const A = 'vup_01J0000000000000000000000A';
            await ins(A, 'private');
            let row = await up.update(await up.byId(A), { title: 'A walk on the coast' });
            assert.strictEqual((await rows('mediahub.video.published')).length, 0, 'private: not published');
            row = await up.update(row, { visibility: 'public' });
            let ev = await rows('mediahub.video.published');
            assert.strictEqual(ev.length, 1);
            assert.ok(row.published_at);
            assert.deepStrictEqual([ev[0].visibility, ev[0].payload.url, ev[0].payload.upload], ['public', `https://openvibe.video/u/${A}`, A]);
            assert.ok(validate('mediahub.video.published@1', ev[0].payload).valid);
            row = await up.update(row, { visibility: 'private' });
            await up.update(row, { visibility: 'public' });
            ev = await rows('mediahub.video.published');
            assert.strictEqual(ev.length, 1, 'once');
        });
    } finally {
        await t0.close();
    }
    done();
})();
