'use strict';
/**
 * Watch ids on openvibe.video (plan track U): one root, /watch?v=<watch id>, for recordings, clips and uploads. The old
 * numbered addresses answer 301 to it (the moment and the playlist carried over), an upload's id is stored once and
 * backfilled in a batch, and the watch page names itself as canonical and in its share sheet.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const VOD_WATCH = 'AAAAAAAAAAA';
const CLIP_WATCH = 'BBBBBBBBBBB';
const UPLOAD_ONE = 'C'.repeat(11);
const UPLOAD_TWO = 'D'.repeat(11);

function startLive() {
    const vod = {
        id: 101, watch_id: VOD_WATCH, title: 'A public recording', description: 'A public stream', duration_seconds: 45,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/101.jpg',
        playback_url: 'https://openvibe.media/v/101', hls_url: null, visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 100, is_recording: false, ai_overview: '',
    };
    const clip = {
        id: 201, watch_id: CLIP_WATCH, vod_id: 101, title: 'A clip', start_time: 5, end_time: 15, duration_seconds: 10,
        created_at: '2026-10-12T11:00:00.000Z', playback_url: 'https://openvibe.media/c/201', thumbnail_url: null,
        visibility: 'public', auto_generated: false, username: 'clipper', display_name: 'Clipper',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer', ai_overview: '',
    };
    const feedVod = { kind: 'vod', id: 101, watch_id: VOD_WATCH, title: 'A public recording', created_at: '2026-10-12T10:00:00.000Z', duration_seconds: 45, views: 100, thumbnail_url: 'https://openvibe.media/t/101.jpg', excerpt: 'A public stream', channel: { username: 'streamer' } };
    const feedClip = { kind: 'clip', id: 201, watch_id: CLIP_WATCH, title: 'A clip', created_at: '2026-10-12T11:00:00.000Z', duration_seconds: 10, views: 20, thumbnail_url: 'https://openvibe.media/t/201.jpg', excerpt: 'A clip overview', channel: { username: 'clipper' } };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const json = (status, body) => { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text); };
        const p = url.pathname;
        if (p === '/api/content/feed') return json(200, { items: url.searchParams.get('type') === 'clips' ? [feedClip] : [feedVod], next: null });
        if (p === '/api/vods/101') return json(200, { vod, clips: [] });
        if (p === '/api/clips/201') return json(200, { clip });
        if (p === '/api/vods') return json(200, { vods: [], total: 0, hasMore: false });
        if (p === '/api/clips') return json(200, { clips: [], total: 0, hasMore: false });
        if (p === '/api/streams') return json(200, { streams: [] });
        if (p === '/api/v1/search') return json(200, { results: [], next_cursor: null, facets: { category: [], channel: [] } });
        return json(404, { error: 'not found' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
    })));
}

function request(base, path, host) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Host: host } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const live = await startLive();
    const t = await boot({
        env: {
            MEDIAHUB_VIDEO_URL: 'https://openvibe.video',
            MEDIAHUB_LIVE_URL: live.url,
            MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live',
            MEDIAHUB_CHAT_URL: live.url,
            MEDIAHUB_SEARCH_URL: live.url,
            MEDIAHUB_VIDEO_SEARCH: 'off',
        },
    });
    const getVideo = (p) => request(t.base, p, 'openvibe.video');
    const db = t.ctx.s.db;

    // The two Media VODs the upload rows point at, and the Live item a watch id resolves to.
    const mockVod = (id, watchId) => ({ id, watch_id: watchId, title: `VOD ${id}`, visibility: 'public', status: 'ready', bytes: Buffer.alloc(0), types: [] });
    t.media.vods.set(1, mockVod(1, UPLOAD_ONE));
    t.media.vods.set(2, mockVod(2, UPLOAD_TWO));
    t.media.vods.set(101, mockVod(101, VOD_WATCH));

    const row = (id, vodId, title) => db.query(`INSERT INTO video_uploads
        (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, status, created_at, updated_at)
        VALUES ($1, $2, NULL, $3, '', 'public', $4, 'video/mp4', 1000, 8388608, 1, 'ready', '2026-11-07 10:00:00', '2026-11-07 10:00:00')`,
    [id, 'user:usr_01JZZZZZZZZZZZZZZZZZZZZZZZ', title, vodId]);
    const ONE = 'vup_ZZZZZZZZZZZZZZZZZZZZZZZZZZ';
    const TWO = 'vup_YYYYYYYYYYYYYYYYYYYYYYYYYY';
    await row(ONE, 1, 'First upload');
    await row(TWO, 2, 'Second upload');

    await check('an upload without a watch id is filled in a batch, once, with a distinct 11-character id', async () => {
        const out = await t.ctx.videoUploads.backfillWatchIds({ limit: 10 });
        assert.deepStrictEqual({ filled: out.filled, remaining: out.remaining }, { filled: 2, remaining: 0 });
        const rows = await db.many('SELECT id, watch_id FROM video_uploads ORDER BY id');
        assert.deepStrictEqual(rows.map((r) => r.watch_id).sort(), [UPLOAD_ONE, UPLOAD_TWO].sort());
        for (const r of rows) assert.ok(/^[A-Za-z0-9_-]{11}$/.test(r.watch_id), `watch id shape: ${r.watch_id}`);
        assert.notStrictEqual(rows[0].watch_id, rows[1].watch_id, 'the ids are distinct');
        const again = await t.ctx.videoUploads.backfillWatchIds({ limit: 10 });
        assert.strictEqual(again.filled, 0, 'a second pass changes nothing');
    });

    await check('the old upload address answers 301 to /watch?v=<id>', async () => {
        const r = await getVideo(`/u/${ONE}`);
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, `/watch?v=${UPLOAD_ONE}`);
    });

    await check('an upload watch page is canonical and shares /watch?v=<id>', async () => {
        const r = await getVideo(`/watch?v=${UPLOAD_ONE}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.video/watch?v=${UPLOAD_ONE}">`), 'canonical');
        assert.ok(r.text.includes(`data-url="https://openvibe.video/watch?v=${UPLOAD_ONE}"`), 'share sheet');
    });

    await check('the old recording address answers 301 and keeps the moment', async () => {
        const r = await getVideo('/v/101?t=30');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, `/watch?v=${VOD_WATCH}&t=30`);
    });

    await check('the old clip address answers 301 to its watch id', async () => {
        const r = await getVideo('/c/201');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, `/watch?v=${CLIP_WATCH}`);
    });

    await check('a recording watch page is canonical at /watch?v=<id>', async () => {
        const r = await getVideo(`/watch?v=${VOD_WATCH}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.video/watch?v=${VOD_WATCH}">`), 'canonical');
        assert.ok(r.text.includes(`data-url="https://openvibe.video/watch?v=${VOD_WATCH}"`), 'share sheet');
    });

    await check('the sitemap lists the watch addresses, not the numbered ones', async () => {
        const r = await getVideo('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes(`/watch?v=${VOD_WATCH}`), 'recording');
        assert.ok(r.text.includes(`/watch?v=${CLIP_WATCH}`), 'clip');
        assert.ok(r.text.includes(`/watch?v=${UPLOAD_ONE}`), 'upload');
        assert.ok(!r.text.includes('/v/101<'), 'no numbered recording page');
    });

    await check('the Markdown twin of a watch page is that page, canonically at /watch?v=<id>', async () => {
        const r = await getVideo(`/watch?v=${UPLOAD_ONE}&format=markdown`);
        assert.strictEqual(r.status, 200, r.text.slice(0, 120));
        assert.ok(r.text.startsWith('---\ntitle:'), `a Markdown twin (${r.text.slice(0, 60)})`);
        assert.ok(r.text.includes(`canonical: "https://openvibe.video/watch?v=${UPLOAD_ONE}"`), 'the twin names the watch address');
    });

    await t.close();
    await live.close();
    done();
})();
