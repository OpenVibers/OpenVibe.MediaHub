'use strict';
/**
 * OpenVibe.Video step A: public watch pages served on Host: openvibe.video, reading OpenVibe.Live's
 * public JSON API through a stub. Covers the home grids, both watch pages (player, tracks, chapters,
 * transcript), the channel page, the two VTT files (exact bytes, escaping included), the sitemap
 * leaving the unlisted VOD out, the video host 404ing the drive's routes, Live being down → 502, and
 * openvibe.download's home being unchanged.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function startLive() {
    const vodFeedItem = {
        key: 'vod:101', kind: 'vod', id: 101, title: 'A public recording',
        created_at: '2026-10-12T10:00:00.000Z', views: 100, duration_seconds: 45,
        thumbnail_url: 'https://openvibe.media/t/101.jpg', excerpt: 'A public stream', ai: false,
        channel: { username: 'streamer', display_name: 'Streamer', avatar_url: null, profile_color: null },
    };
    const clipFeedItem = {
        key: 'clip:201', kind: 'clip', id: 201, title: 'A clip',
        created_at: '2026-10-12T11:00:00.000Z', views: 20, duration_seconds: 10,
        thumbnail_url: null, excerpt: 'A clip overview', ai: false,
        channel: { username: 'clipper', display_name: 'Clipper', avatar_url: null, profile_color: null },
    };
    const publicVod = {
        id: 101, title: 'A public recording', description: 'A public stream', duration_seconds: 45,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/101.jpg',
        playback_url: 'https://openvibe.media/v/101', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', avatar_url: null, profile_color: null,
        ai_overview: 'A public overview.',
        ai_transcript_json: [
            { start: 0, end: 2, text: 'Hi & bye <tag> --> here' },
            { start: 2, end: 4, text: 'Second\nline --> done' },
        ],
        transcript_status: 'done', stream_category: 'Just Chatting', stream_started_at: '2026-10-12T09:30:00.000Z',
        stream_peak_viewers: 12, comment_count: 3, view_count: 100, is_recording: false,
    };
    const unlistedVod = {
        id: 102, title: 'An unlisted recording', description: '', duration_seconds: 20,
        created_at: '2026-10-11T10:00:00.000Z', thumbnail_url: null,
        playback_url: 'https://openvibe.media/v/102', visibility: 'unlisted',
        username: 'streamer', display_name: 'Streamer', view_count: 5, is_recording: false,
        ai_overview: '', ai_transcript_json: null,
    };
    const publicClip = {
        id: 201, vod_id: 101, title: 'A clip', start_time: 5, end_time: 15, duration_seconds: 10,
        playback_url: 'https://openvibe.media/c/201', thumbnail_url: null, visibility: 'public',
        auto_generated: false, username: 'clipper', display_name: 'Clipper',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer',
        ai_overview: 'A clip overview', comment_count: 2,
    };
    const vodListItem = {
        id: 101, title: 'A public recording', description: 'A public stream', duration_seconds: 45,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/101.jpg',
        playback_url: 'https://openvibe.media/v/101', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 100,
    };
    const clipListItem = {
        id: 201, title: 'A clip', duration_seconds: 10, created_at: '2026-10-12T11:00:00.000Z',
        thumbnail_url: null, playback_url: 'https://openvibe.media/c/201', visibility: 'public',
        username: 'clipper', display_name: 'Clipper',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer', view_count: 20,
    };

    const state = { down: false };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const json = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        if (state.down) return json(503, { error: 'Live is down' });

        const p = url.pathname;
        if (p === '/api/content/feed') {
            const type = url.searchParams.get('type');
            if (type === 'vods') return json(200, { items: [vodFeedItem], next: null });
            if (type === 'clips') return json(200, { items: [clipFeedItem], next: null });
            return json(200, { items: [], next: null });
        }
        if (p === '/api/vods') {
            const username = url.searchParams.get('username');
            if (username === 'streamer') return json(200, { vods: [vodListItem], total: 1, hasMore: false });
            return json(200, { vods: [], total: 0, hasMore: false });
        }
        if (p === '/api/clips') {
            const username = url.searchParams.get('username');
            if (username === 'streamer') return json(200, { clips: [clipListItem], total: 1, hasMore: false });
            return json(200, { clips: [], total: 0, hasMore: false });
        }
        const memories = /^\/api\/vods\/(\d+)\/memories$/.exec(p);
        if (memories) {
            if (memories[1] === '103') return json(404, { error: 'not found' });
            if (memories[1] === '101') return json(200, { memories: [{ offset_seconds: 10, description: 'Intro & setup' }, { offset_seconds: 30, description: 'The <main> part' }] });
            return json(200, { memories: [] });
        }
        const vodDetail = /^\/api\/vods\/(\d+)$/.exec(p);
        if (vodDetail) {
            if (vodDetail[1] === '103') return json(404, { error: 'not found' });
            if (vodDetail[1] === '101') return json(200, { vod: publicVod, clips: [clipListItem] });
            if (vodDetail[1] === '102') return json(200, { vod: unlistedVod, clips: [] });
            return json(404, { error: 'not found' });
        }
        const clipDetail = /^\/api\/clips\/(\d+)$/.exec(p);
        if (clipDetail) {
            if (clipDetail[1] === '201') return json(200, { clip: publicClip });
            return json(404, { error: 'not found' });
        }
        const comments = /^\/api\/comments\/(vod|clip)\/(\d+)$/.exec(p);
        if (comments) {
            return json(200, { comments: [], total: 0, thread: { id: `thr_${comments[1]}_${comments[2]}`, url: `https://openvibe.community/t/${comments[1]}-${comments[2]}` } });
        }
        return json(404, { error: 'not found' });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            setDown: (v) => { state.down = v; },
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

function request(base, path, host) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { Host: host },
        }, (res) => {
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
        },
    });
    const getVideo = (p) => request(t.base, p, 'openvibe.video');
    const getDownload = (p) => request(t.base, p, 'openvibe.download');

    await check('Live being down renders a 502 page', async () => {
        live.setDown(true);
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 502);
        assert.ok(r.text.includes('did not answer'), r.text.slice(0, 300));
        live.setDown(false);
    });

    await check('the video home shows both latest grids and links the watch pages', async () => {
        const r = await getVideo('/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('OpenVibe.Video'));
        assert.ok(r.text.includes('Latest recordings'));
        assert.ok(r.text.includes('Latest clips'));
        assert.ok(r.text.includes('/v/101'));
        assert.ok(r.text.includes('/c/201'));
        assert.ok(!r.text.includes('/v/102'), 'the unlisted VOD is not in a list');
    });

    await check('the VOD watch page has a player, both tracks, chapters and a transcript', async () => {
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<video'), 'a video element');
        assert.ok(r.text.includes('src="https://openvibe.media/v/101"'), 'the playback url');
        assert.ok(r.text.includes('preload="metadata"'));
        assert.ok(r.text.includes('playsinline'));
        assert.ok(r.text.includes('data-ovv-video'));
        assert.ok(r.text.includes('kind="captions"') && r.text.includes('src="/v/101/captions.vtt"'), 'the transcript track');
        assert.ok(r.text.includes('kind="chapters"') && r.text.includes('src="/v/101/chapters.vtt"'), 'the chapters track');
        assert.ok(r.text.includes('Chapters'));
        assert.ok(r.text.includes('Transcript'));
        assert.ok(r.text.includes('A public overview'));
        assert.ok(r.text.includes('/@streamer'));
        assert.ok(r.text.includes('Manage on OpenVibe.Live'));
        assert.ok(r.text.includes('Discuss on OpenVibe.Community'));
        assert.ok(r.text.includes('data-ovv-chapter'));
        assert.ok(r.text.includes('data-ovv-seek'));
    });

    await check('the clip watch page attributes its maker and links the full recording', async () => {
        const r = await getVideo('/c/201');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('src="https://openvibe.media/c/201"'), 'the clip playback url');
        assert.ok(r.text.includes('Made by Clipper'), 'attributed to the person who made it');
        assert.ok(r.text.includes('Watch in the full recording'));
        assert.ok(r.text.includes('/v/101?t=5'), 'the full recording link carries the clip start');
        assert.ok(r.text.includes('Discuss on OpenVibe.Community'));
        assert.ok(r.text.includes('Manage on OpenVibe.Live'));
    });

    await check('an unlisted VOD is reachable but noindex', async () => {
        const r = await getVideo('/v/102');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('An unlisted recording'));
        assert.ok(r.text.includes('<meta name="robots" content="noindex">'));
    });

    await check('a private VOD is a 404', async () => {
        assert.strictEqual((await getVideo('/v/103')).status, 404);
    });

    await check('the channel page lists recordings and clips', async () => {
        const r = await getVideo('/@streamer');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('@streamer'));
        assert.ok(r.text.includes('Recordings'));
        assert.ok(r.text.includes('/v/101'));
        assert.ok(r.text.includes('Clips'));
        assert.ok(r.text.includes('/c/201'));
    });

    await check('captions.vtt is exact, escaping and collapsing cue text', async () => {
        const r = await getVideo('/v/101/captions.vtt');
        assert.strictEqual(r.status, 200);
        assert.ok(String(r.headers['content-type']).includes('text/vtt'));
        assert.strictEqual(r.text, 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHi &amp; bye &lt;tag&gt; here\n\n00:00:02.000 --> 00:00:04.000\nSecond line done\n');
    });

    await check('chapters.vtt runs each moment to the next or the end', async () => {
        const r = await getVideo('/v/101/chapters.vtt');
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.text, 'WEBVTT\n\n00:00:10.000 --> 00:00:30.000\nIntro &amp; setup\n\n00:00:30.000 --> 00:00:45.000\nThe &lt;main&gt; part\n');
    });

    await check('the sitemap lists public items and leaves the unlisted VOD out', async () => {
        const r = await getVideo('/sitemap.xml');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('https://openvibe.video/v/101'));
        assert.ok(r.text.includes('https://openvibe.video/c/201'));
        assert.ok(!r.text.includes('/v/102'));
    });

    await check('robots.txt and llms.txt answer on the video host', async () => {
        const robots = await getVideo('/robots.txt');
        assert.strictEqual(robots.status, 200);
        assert.ok(robots.text.includes('https://openvibe.video/sitemap.xml'));
        const llms = await getVideo('/llms.txt');
        assert.strictEqual(llms.status, 200);
        assert.ok(llms.text.includes('# OpenVibe.Video'));
    });

    await check('legal pages on the video host name openvibe.video', async () => {
        const terms = await getVideo('/terms');
        assert.strictEqual(terms.status, 200);
        assert.ok(terms.text.includes('openvibe.video'));
        assert.ok(terms.text.includes('OpenVibe.Video'));
    });

    await check('the drive routes 404 on the video host', async () => {
        assert.strictEqual((await getVideo('/files')).status, 404);
        assert.strictEqual((await getVideo('/api/v1/files')).status, 404);
    });

    await check("the drive's home on openvibe.download is unchanged", async () => {
        const r = await getDownload('/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('private drive'));
    });

    await t.close();
    await live.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
