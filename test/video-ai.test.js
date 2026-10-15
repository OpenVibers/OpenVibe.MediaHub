'use strict';
/**
 * The AI edit of an upload (server/video/ai-edit.js): OpenVibe.AI's media.analyze on the finished video, read through
 * Media's signed URL (private ones too), never a paid model; the transcript becomes captions, the highlights chapters,
 * the overview a summary the owner may take as the description. A run still going is joined by the same key; a
 * failure waits and retries with a new one.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { chaptersOf } = require('../server/video/ai-edit');

function startStub(handler) {
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const out = handler(req, raw ? JSON.parse(raw) : null);
            res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out.body || {}));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function vreq(base, path, { method = 'GET', cookie, form, json, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: 'openvibe.video' };
        if (cookie) h.cookie = cookie;
        if (method !== 'GET') h['sec-fetch-site'] = 'same-origin';
        let data;
        if (form) { data = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; }
        if (json) { data = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
        if (body) { data = body; h['content-type'] = 'application/octet-stream'; }
        if (data) h['content-length'] = data.length;
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

const OUTPUT = {
    duration_seconds: 300, analyzed_seconds: 300,
    overview: { text: 'A walk along the coast at sunset, talking about the tide and the birds.', source: 'local_model', provider: 'local', model: 'qwen' },
    transcript: { available: true, language: 'en', text: 'hello', segments: [{ start: 0.5, end: 4, text: 'Hello from the coast.' }, { start: 4, end: 9.2, text: 'The tide is coming in.' }] },
    highlights: [{ start: 130, end: 140, score: 0.8, reasons: ['speech'], excerpt: 'Look at those birds over the water' }, { start: 40, end: 50, score: 0.9, reasons: ['loud'], excerpt: 'Waves' }, { start: 45, end: 55, score: 0.5, reasons: ['speech'], excerpt: 'too close to the last one' }],
};

(async () => {
    await check('chapters: in time order, 20 s apart, a Start chapter, named by what was said', () => {
        assert.deepStrictEqual(chaptersOf(OUTPUT.highlights), [{ start: 0, title: 'Start' }, { start: 40, title: 'Waves' }, { start: 130, title: 'Look at those birds over the water' }]);
        assert.deepStrictEqual(chaptersOf(null), []);
    });

    const runs = [];
    let mode = 'running';
    const ai = await startStub((req, body) => {
        runs.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
        if (mode === 'fail') return { status: 503, body: { code: 'ai.unavailable' } };
        if (mode === 'running') return { status: 202, body: { run: { id: 'run_1', status: 'running' } } };
        return { status: req.method === 'GET' ? 200 : 201, body: { run: { id: 'run_1', status: 'succeeded', output: OUTPUT } } };
    });
    const live = await startStub(() => ({ body: { vods: [], clips: [], items: [], hasMore: false } }));
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url, OV_AI_INTERNAL_URL: ai.url } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimCookie = t.signIn(kim);
    const samCookie = t.signIn(sam);
    let id;

    await check('a finished private upload is analysed through a signed URL, never a paid model; a run still going is read again by its id', async () => {
        const start = await vreq(t.base, '/api/v1/videos', { method: 'POST', json: { title: 'Coast', size: 10, content_type: 'video/mp4', name: 'c.mp4', visibility: 'private' }, cookie: kimCookie });
        id = start.json().upload.id;
        await vreq(t.base, `/api/v1/videos/${id}/parts/1`, { method: 'PUT', body: Buffer.alloc(10, 1), cookie: kimCookie });
        await vreq(t.base, `/api/v1/videos/${id}/complete`, { method: 'POST', cookie: kimCookie });
        for (let i = 0; i < 20 && !(await vreq(t.base, `/u/${id}`, { cookie: kimCookie })).text.includes('data-ovv-video'); i++) await new Promise((r) => setTimeout(r, 50));
        assert.ok(t.ctx.videoAi.enabled);
        await t.ctx.videoAi.sweep();
        assert.strictEqual(runs.length, 1);
        const r = runs[0];
        assert.strictEqual(r.body.workflow, 'media.analyze');
        assert.deepStrictEqual(r.body.input, { media_url: 'https://openvibe.media/v/vod-1.mp4?exp=9999999999&sig=stand-in', language: 'auto', allow_paid: false });
        assert.strictEqual(r.body.idempotency_key, `media-hub.video.analyze:${id}:1`);
        assert.match(r.path, /^\/api\/v1\/runs\?wait=60000$/);
        assert.ok(String(r.auth).startsWith('Bearer '));
        const row = await t.ctx.videoAi.forUpload({ id });
        assert.strictEqual(row.status, 'running');
        // Due again later: read the same run by its id (posting again would carry a new signed URL under the same key).
        await t.ctx.s.db.query('UPDATE video_upload_ai SET next_at = $1 WHERE upload_id = $2', ['2000-01-01T00:00:00.000Z', id]);
        mode = 'done';
        await t.ctx.videoAi.sweep();
        assert.deepStrictEqual([runs[1].method, runs[1].path], ['GET', '/api/v1/runs/run_1'], 'read, not a second analysis');
        assert.strictEqual((await t.ctx.videoAi.forUpload({ id })).status, 'done');
    });

    await check('the page: captions and chapters tracks, the transcript, the chapters, the summary and the owner\'s button', async () => {
        const page = await vreq(t.base, `/u/${id}`, { cookie: kimCookie });
        assert.ok(page.text.includes(`<track kind="captions" label="Captions (AI)" src="/u/${id}/captions.vtt" default>`));
        assert.ok(page.text.includes(`<track kind="chapters" src="/u/${id}/chapters.vtt">`));
        assert.ok(page.text.includes('A walk along the coast at sunset') && page.text.includes('Written by AI'));
        assert.ok(page.text.includes('Use this as the description'));
        assert.ok(page.text.includes('The tide is coming in.'), 'the transcript');
        assert.ok(page.text.includes('Look at those birds over the water'), 'the chapters');
        const vtt = await vreq(t.base, `/u/${id}/captions.vtt`, { cookie: kimCookie });
        assert.ok(vtt.text.startsWith('WEBVTT') && vtt.text.includes('00:00:04.000 --> 00:00:09.200'));
        const ch = await vreq(t.base, `/u/${id}/chapters.vtt`, { cookie: kimCookie });
        assert.ok(ch.text.includes('Waves'));
        assert.strictEqual((await vreq(t.base, `/u/${id}/captions.vtt`, { cookie: samCookie })).status, 404, 'private: not for someone else');
        const use = await vreq(t.base, `/u/${id}/manage`, { method: 'POST', cookie: kimCookie, form: { description: OUTPUT.overview.text } });
        assert.strictEqual(use.status, 303);
        const row = await t.ctx.videoUploads.byId(id);
        assert.strictEqual(row.description, OUTPUT.overview.text);
        assert.deepStrictEqual([row.title, row.visibility], ['Coast', 'private'], 'a description-only change keeps the title and visibility');
    });

    await check('a failure waits and retries with a new key; four attempts at most', async () => {
        await t.ctx.s.db.query("UPDATE video_upload_ai SET status = 'queued', attempts = 0, next_at = NULL WHERE upload_id = $1", [id]);
        mode = 'fail';
        await t.ctx.videoAi.sweep();
        let row = await t.ctx.videoAi.forUpload({ id });
        assert.deepStrictEqual([row.status, row.attempts], ['queued', 1]);
        assert.ok(row.next_at > new Date().toISOString(), 'waits before the next try');
        await t.ctx.s.db.query("UPDATE video_upload_ai SET attempts = 3, next_at = NULL WHERE upload_id = $1", [id]);
        await t.ctx.videoAi.sweep();
        row = await t.ctx.videoAi.forUpload({ id });
        assert.strictEqual(row.status, 'failed', 'the fourth failure is final');
        assert.strictEqual(runs[runs.length - 1].body.idempotency_key, `media-hub.video.analyze:${id}:4`);
    });

    await t.close();
    await ai.close();
    await live.close();
    done();
})();
