'use strict';
/**
 * Watch ids on openvibe.video: a page is /watch?v=<watch id>, YouTube's shape, for all three kinds of video — a stream
 * recording and a clip (their ids minted by OpenVibe.Media) and an upload (its own, migration 0024).
 *
 *   - the old addresses (/v/:id, /c/:id, /u/:vup_…) answer 301 to the watch page, ?t= and ?list= carried;
 *   - the watch page names itself as canonical, in its share button, its JSON-LD and its Markdown twin;
 *   - the sitemap carries the watch address, never the number;
 *   - the ids are random, 11 characters, unique, and never the row's own id.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const VOD_WATCH = 'vodWatch001';
const CLIP_WATCH = 'clipWatch01';
const UPLOAD_WATCH = 'upWatch0001';
const UPLOAD_ID = 'vup_01J0000000000000000000000C';

function startLive() {
    const vod = {
        id: 101, title: 'A public recording', description: 'A public stream', duration_seconds: 300,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/101.jpg',
        playback_url: 'https://openvibe.media/v/101', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 100, is_recording: false,
        watch_id: VOD_WATCH, ai_overview: '', ai_transcript_json: null,
    };
    const clip = {
        id: 201, vod_id: 101, title: 'A clip', start_time: 5, end_time: 15, duration_seconds: 10,
        playback_url: 'https://openvibe.media/c/201', thumbnail_url: null, visibility: 'public',
        auto_generated: false, username: 'clipper', display_name: 'Clipper',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer',
        watch_id: CLIP_WATCH, ai_overview: '', view_count: 20,
    };
    const feed = {
        vod: { key: 'vod:101', kind: 'vod', id: 101, title: vod.title, created_at: vod.created_at, views: 100, duration_seconds: 300, thumbnail_url: vod.thumbnail_url, excerpt: 'A public stream', watch_id: VOD_WATCH, channel: { username: 'streamer', display_name: 'Streamer' } },
        clip: { key: 'clip:201', kind: 'clip', id: 201, title: clip.title, created_at: '2026-10-12T11:00:00.000Z', views: 20, duration_seconds: 10, thumbnail_url: null, excerpt: '', watch_id: CLIP_WATCH, channel: { username: 'clipper', display_name: 'Clipper' } },
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const json = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        if (url.pathname === '/api/vods/101') return json(200, { vod, clips: [] });
        if (url.pathname === '/api/clips/201') return json(200, { clip });
        if (url.pathname === '/api/content/feed') return json(200, { items: [feed.vod, feed.clip], hasMore: false, total: 2 });
        return json(404, { error: 'Not found' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url } });
    // OpenVibe.Media is the one authority that says which item a watch id names.
    t.media.watches.set(VOD_WATCH, { kind: 'vod', id: 101 });
    t.media.watches.set(CLIP_WATCH, { kind: 'clip', id: 201 });
    t.media.vods.set(950, { id: 950, title: 'A home video', visibility: 'public', bytes: Buffer.alloc(10), types: ['video/mp4'], status: 'ready' });
    await t.ctx.s.db.exec(`INSERT INTO video_uploads (id, watch_id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at, duration_seconds, views)
                           VALUES ($1, $2, 'user:nobody', 'kim', 'A home video', '', 'public', 950, 'video/mp4', 1000, 1000, 1, 1, 'ready', 'active', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', 125, 0)`,
    [UPLOAD_ID, UPLOAD_WATCH]);
    // Every page of the video host, as a browser reaches it (fetch's Host header is ignored, so the bare client is used).
    const vget = (path, { headers = {} } = {}) => new Promise((resolve, reject) => {
        const u = new URL(t.base + path);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Host: 'openvibe.video', ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text }); });
        });
        req.on('error', reject);
        req.end();
    });

    await check('a recording: /v/:id answers 301 to /watch?v=<watch id>, ?t= and ?list= carried', async () => {
        const r = await vget('/v/101');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers['location'], `/watch?v=${VOD_WATCH}`, 'the watch page');
        const withQuery = await vget('/v/101?t=42&list=pl_abc');
        assert.strictEqual(withQuery.headers['location'], `/watch?v=${VOD_WATCH}&t=42&list=pl_abc`);
    });

    await check('the recording\'s watch page: canonical, share, JSON-LD and twin all name /watch?v=', async () => {
        const r = await vget(`/watch?v=${VOD_WATCH}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.video/watch?v=${VOD_WATCH}">`), 'canonical');
        assert.ok(r.text.includes(`<link rel="alternate" type="text/markdown" href="https://openvibe.video/watch.md?v=${VOD_WATCH}">`), 'the twin');
        assert.ok(r.headers['link'].includes(`<https://openvibe.video/watch.md?v=${VOD_WATCH}>; rel="alternate"; type="text/markdown"`), 'the Link header too');
        assert.ok(r.text.includes(`data-url="https://openvibe.video/watch?v=${VOD_WATCH}"`), 'the share button');
        const ld = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(r.text)[1])['@graph'].find((x) => x['@type'] === 'VideoObject');
        assert.strictEqual(ld.url, `https://openvibe.video/watch?v=${VOD_WATCH}`);
    });

    await check('a clip: /c/:id answers 301, and its watch page names itself', async () => {
        const old = await vget('/c/201');
        assert.strictEqual(old.status, 301);
        assert.strictEqual(old.headers['location'], `/watch?v=${CLIP_WATCH}`);
        const r = await vget(`/watch?v=${CLIP_WATCH}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.video/watch?v=${CLIP_WATCH}">`));
        assert.ok(r.text.includes(`data-url="https://openvibe.video/watch?v=${CLIP_WATCH}"`));
        assert.ok(r.text.includes(`data-ovv-view="https://openvibe.live/api/views/clip/201"`), 'still counts the view on Live');
    });

    await check('an upload: /u/<vup_…> answers 301, and its watch page names itself', async () => {
        const old = await vget(`/u/${UPLOAD_ID}`);
        assert.strictEqual(old.status, 301);
        assert.strictEqual(old.headers['location'], `/watch?v=${UPLOAD_WATCH}`);
        const r = await vget(`/watch?v=${UPLOAD_WATCH}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.video/watch?v=${UPLOAD_WATCH}">`));
        assert.ok(r.text.includes(`data-url="https://openvibe.video/watch?v=${UPLOAD_WATCH}"`));
        assert.ok(r.text.includes('<h1 class="ovv-title">A home video</h1>'));
    });

    await check('the Markdown twin is /watch.md?v=<watch id>, of the same page', async () => {
        const r = await vget(`/watch.md?v=${VOD_WATCH}`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(/^text\/markdown/.test(r.headers['content-type']));
        assert.ok(r.text.includes(`canonical: "https://openvibe.video/watch?v=${VOD_WATCH}"`));
    });

    await check('an unknown or malformed watch id is a 404, never another video', async () => {
        assert.strictEqual((await vget('/watch?v=unknown0000')).status, 404);
        assert.strictEqual((await vget('/watch?v=/etc/passwd')).status, 404);
        assert.strictEqual((await vget('/watch')).status, 404);
    });

    await check('the sitemap carries the watch address, never the number', async () => {
        const r = await vget('/sitemap.xml');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes(`<loc>https://openvibe.video/watch?v=${VOD_WATCH}</loc>`), 'the recording');
        assert.ok(r.text.includes(`<loc>https://openvibe.video/watch?v=${CLIP_WATCH}</loc>`), 'the clip');
        assert.ok(r.text.includes(`<loc>https://openvibe.video/watch?v=${UPLOAD_WATCH}</loc>`), 'the upload');
        assert.ok(!r.text.includes('<loc>https://openvibe.video/v/101</loc>'));
        assert.ok(!r.text.includes(`<loc>https://openvibe.video/u/${UPLOAD_ID}</loc>`));
    });

    await check('the ids: 11 URL-safe characters, unique, random, and never the row\'s own id', async () => {
        const s = t.ctx.s;
        const ids = [];
        for (let i = 0; i < 40; i++) ids.push(`vup_${String(i).padStart(26, '0')}`);
        for (const id of ids) {
            await s.db.exec(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at, duration_seconds, views)
                             VALUES ($1, 'user:nobody', 'kim', 'Bulk', '', 'public', NULL, 'video/mp4', 1, 1, 1, 1, 'ready', 'active', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', 1, 0)`, [id]);
        }
        const out = await t.ctx.videoUploads.backfillWatchIds({ log: null });
        assert.strictEqual(out.remaining, 0, 'every row has one');
        const rows = await s.db.many('SELECT id, watch_id FROM video_uploads');
        const minted = rows.filter((r) => r.watch_id);
        assert.strictEqual(minted.length, rows.length);
        const watchIds = minted.map((r) => r.watch_id);
        assert.strictEqual(new Set(watchIds).size, watchIds.length, 'all unique');
        for (const w of watchIds) assert.match(w, /^[A-Za-z0-9_-]{11}$/, `an 11-character id (${w})`);
        for (const r of minted) assert.notStrictEqual(r.watch_id, r.id, 'never the row\'s own id');
        // Random, not sequential: neighbouring ids share nothing, unlike a counter.
        const sorted = [...watchIds].sort();
        const increments = sorted.filter((w, i) => i && w.slice(0, 6) === sorted[i - 1].slice(0, 6)).length;
        assert.ok(increments < sorted.length / 2, `not a sequence (${increments} of ${sorted.length} share a prefix)`);
    });

    await t.close();
    await live.close();
    done();
})();
