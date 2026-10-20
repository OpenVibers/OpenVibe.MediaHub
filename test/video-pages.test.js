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
        playback_url: 'https://openvibe.media/v/101', hls_url: 'https://openvibe.media/o/med_101/master.m3u8', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', avatar_url: null, profile_color: null,
        ai_overview: 'A public overview.',
        ai_transcript_json: [
            { start: 0, end: 2, text: 'Hi & bye <tag> --> here' },
            { start: 2, end: 4, text: 'Second\nline --> done' },
        ],
        transcript_status: 'done', stream_category: 'Just Chatting', stream_id: 1001, stream_started_at: '2026-10-12 09:30:00', stream_ended_at: '2026-10-12 09:30:45',
        stream_peak_viewers: 12, comment_count: 3, view_count: 100, is_recording: false,
    };
    const unlistedVod = {
        id: 102, title: 'An unlisted recording', description: '', duration_seconds: 20,
        created_at: '2026-10-11T10:00:00.000Z', thumbnail_url: null,
        playback_url: 'https://openvibe.media/v/102', hls_url: 'https://evil.example/o/med_102/master.m3u8', visibility: 'unlisted',
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
        playback_url: 'https://openvibe.media/v/101', hls_url: 'https://openvibe.media/o/med_101/master.m3u8', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 100,
    };
    const clipListItem = {
        id: 201, title: 'A clip', duration_seconds: 10, created_at: '2026-10-12T11:00:00.000Z',
        thumbnail_url: null, playback_url: 'https://openvibe.media/c/201', visibility: 'public',
        username: 'clipper', display_name: 'Clipper',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer', view_count: 20,
    };

    const comments101 = [
        { id: 'c1', message: 'Nice <b>stream</b>!', display_name: 'Commenter', username: 'commenter', created_at: '2026-10-12T10:00:00.000Z', reply_count: 3, is_deleted: 0, deleted: false },
        { id: 'c2', message: 'Agreed', display_name: null, username: 'other_user', created_at: '2026-10-12T10:05:00.000Z', reply_count: 0, is_deleted: 0, deleted: false },
        { id: 'c3', message: '', display_name: null, username: null, created_at: '2026-10-12T10:10:00.000Z', reply_count: 0, is_deleted: 1, deleted: true },
    ];
    const chatMessages101 = [
        { id: 'm1', timestamp: '2026-10-12 09:29:59', username: 'early', display_name: 'Early', message: 'EARLY_MSG_XYZ', message_type: 'chat', user_id: 900001, anon_id: 'anon-PRIVATE-1', metadata: { note: 'meta-PRIVATE-1' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm2', timestamp: '2026-10-12 09:30:05', username: 'viewer', display_name: 'Viewer', message: 'Hello <b>world</b>', message_type: 'chat', user_id: 900002, anon_id: 'anon-PRIVATE-2', metadata: { note: 'meta-PRIVATE-2' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm3', timestamp: '2026-10-12 09:30:10', username: 'deleted_user', display_name: 'Deleted', message: 'DELETED_MSG_XYZ', message_type: 'chat', is_deleted: true, user_id: 900003, anon_id: 'anon-PRIVATE-3', metadata: { note: 'meta-PRIVATE-3' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm4', timestamp: '2026-10-12 09:30:15', username: 'filtered_user', display_name: 'Filtered', message: 'FILTERED_MSG_XYZ', message_type: 'chat', is_filtered: true, user_id: 900004, anon_id: 'anon-PRIVATE-4', metadata: { note: 'meta-PRIVATE-4' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm5', timestamp: '2026-10-12 09:30:20', username: 'system', display_name: 'System', message: 'SYSTEM_MSG_XYZ', message_type: 'system', user_id: 900005, anon_id: 'anon-PRIVATE-5', metadata: { note: 'meta-PRIVATE-5' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm6', timestamp: '2026-10-12 09:30:25', username: 'viewer2', display_name: 'Viewer Two', message: 'Second message', message_type: 'chat', user_id: 900006, anon_id: 'anon-PRIVATE-6', metadata: { note: 'meta-PRIVATE-6' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
        { id: 'm7', timestamp: '2026-10-12 09:32:00', username: 'late', display_name: 'Late', message: 'LATE_MSG_XYZ', message_type: 'chat', user_id: 900007, anon_id: 'anon-PRIVATE-7', metadata: { note: 'meta-PRIVATE-7' }, profile_color: '#PRIVATE-COLOR', role: 'PRIVATE-ROLE' },
    ];
    const manyChatMessages = Array.from({ length: 1005 }, function (_, i) {
        return { id: 'many_' + i, timestamp: '2026-10-12 09:30:01', username: 'viewer', display_name: 'Viewer', message: 'Many message ' + i, message_type: 'chat' };
    });
    const secondVod = {
        id: 104, title: 'A long recording', description: '', duration_seconds: 300,
        created_at: '2026-10-12T09:30:00.000Z', thumbnail_url: null,
        playback_url: 'https://openvibe.media/v/104', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 50, is_recording: false,
        ai_overview: '', ai_transcript_json: null,
        stream_id: 1002, stream_started_at: '2026-10-12 09:30:00', stream_ended_at: '2026-10-12 09:35:00',
    };
    // Twenty seconds with nothing written about it: a test stream, left out of search.
    const thinVod = { ...secondVod, id: 106, title: "Streamer's Channel", duration_seconds: 20, stream_category: null };
    // Live's answer since T4 step 5: playback_url is the playlist, file_url the file.
    const hlsFirstVod = { ...secondVod, id: 105, title: 'Playlist first', playback_url: 'https://openvibe.media/o/med_105/master.m3u8',
        hls_url: 'https://openvibe.media/o/med_105/master.m3u8', file_url: 'https://openvibe.media/v/105' };
    const state = { down: false, chatDown: false };
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
            if (type === 'vods') return json(200, { items: [vodFeedItem, { ...vodFeedItem, key: 'vod:109', id: 109, title: 'A two-second blip', duration_seconds: 2 }, { ...vodFeedItem, key: 'vod:110', id: 110, title: "Streamer's Channel", duration_seconds: 10, excerpt: null }], next: null });
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
            if (vodDetail[1] === '104') return json(200, { vod: secondVod, clips: [] });
            if (vodDetail[1] === '106') return json(200, { vod: thinVod, clips: [] });
            if (vodDetail[1] === '105') return json(200, { vod: hlsFirstVod, clips: [] });
            return json(404, { error: 'not found' });
        }
        const clipDetail = /^\/api\/clips\/(\d+)$/.exec(p);
        if (clipDetail) {
            if (clipDetail[1] === '201') return json(200, { clip: publicClip });
            return json(404, { error: 'not found' });
        }
        const comments = /^\/api\/comments\/(vod|clip)\/(\d+)$/.exec(p);
        if (comments) {
            if (comments[1] === 'vod' && comments[2] === '101') {
                return json(200, { comments: comments101, total: comments101.length, thread: { id: 'thr_vod_101', url: 'https://openvibe.community/t/vod-101' } });
            }
            return json(200, { comments: [], total: 0, thread: { id: `thr_${comments[1]}_${comments[2]}`, url: `https://openvibe.community/t/${comments[1]}-${comments[2]}` } });
        }
        const chatReplay = /^\/api\/chat\/(\d+)\/replay$/.exec(p);
        if (chatReplay) {
            if (state.chatDown) return json(503, { error: 'Chat is down' });
            if (chatReplay[1] === '1001') return json(200, { messages: chatMessages101 });
            if (chatReplay[1] === '1002') return json(200, { messages: manyChatMessages });
            return json(200, { messages: [] });
        }
        return json(404, { error: 'not found' });
    });

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            setDown: (v) => { state.down = v; },
            setChatDown: (v) => { state.chatDown = v; },
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

function countOccurrences(haystack, needle) {
    let n = 0;
    let i = 0;
    while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
    return n;
}

(async () => {
    const live = await startLive();
    const t = await boot({
        env: {
            MEDIAHUB_VIDEO_URL: 'https://openvibe.video',
            MEDIAHUB_LIVE_URL: live.url,
            MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live',
            MEDIAHUB_CHAT_URL: live.url,
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

    await check('Chat being down still renders the VOD page without a chat panel', async () => {
        live.setChatDown(true);
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(!r.text.includes('Chat replay'), 'no chat panel when Chat is down');
        assert.ok(!r.text.includes('ovv-chat'), 'no chat markup when Chat is down');
        live.setChatDown(false);
    });

    await check('the player shows the item\'s picture until it plays (a 1280 px WebP of a Media thumbnail)', async () => {
        const vod = await getVideo('/v/101');
        assert.ok(/<video class="ovv-player"[^>]* poster="https:\/\/openvibe\.media\/t\/101\.jpg\?w=1280&amp;fmt=webp"/.test(vod.text), vod.text.match(/<video[^>]*>/)?.[0]);
        const clip = await getVideo('/c/201');
        assert.ok(clip.status !== 200 || !/<video class="ovv-player"[^>]* poster=/.test(clip.text), 'no thumbnail, no poster');
    });

    await check('the video host answers /release.json too (the shared release check reads its own origin)', async () => {
        const r = await getVideo('/release.json');
        assert.strictEqual(r.status, 200);
        const j = JSON.parse(r.text);
        assert.ok(j.release && j.service, JSON.stringify(j).slice(0, 200));
    });

    await check('the video home shows both latest grids and links the watch pages', async () => {
        const r = await getVideo('/');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('OpenVibe.Video'));
        assert.ok(r.text.includes('Latest recordings'));
        assert.ok(r.text.includes('Latest clips'));
        assert.ok(r.text.includes('/v/101'));
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((m) => [].concat(JSON.parse(m[1])));
        assert.ok(ld.some((n) => n['@type'] === 'WebSite' && n.name === 'OpenVibe.Video'), 'the home says what the site is (JSON-LD)');
        assert.ok(r.text.includes('/c/201'));
        assert.ok(!r.text.includes('/v/102'), 'the unlisted VOD is not in a list');
        assert.ok(!r.text.includes('/v/109'), 'a recording under 15 seconds gets no tile on the front page');
        // openvibe.media thumbnails are asked for in sizes: a 480 px WebP by default, 320/480/640 in the srcset.
        assert.ok(r.text.includes('src="https://openvibe.media/t/101.jpg?w=480&amp;fmt=webp"'), 'a WebP thumbnail near the card width');
        assert.ok(r.text.includes('https://openvibe.media/t/101.jpg?w=320&amp;fmt=webp 320w, https://openvibe.media/t/101.jpg?w=480&amp;fmt=webp 480w, https://openvibe.media/t/101.jpg?w=640&amp;fmt=webp 640w'), 'the srcset ladder');
        assert.ok(/sizes="\(max-width: 520px\) calc\(100vw - 32px\)/.test(r.text), 'sizes follows the grid');
    });

    await check('the VOD watch page has a player, both tracks, chapters and a transcript', async () => {
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<video'), 'a video element');
        assert.ok(r.text.includes('src="https://openvibe.media/v/101"'), 'the playback url');
        assert.match(r.text, /class="ovv-avatar"[^>]*>S<img src="[^"]*\/avatar\/streamer" alt="" loading="lazy">/, 'the streamer\'s picture over the letter');
        assert.match(r.text, /<title>[^<]*\(@streamer, Oct 12, 2026\)[^<]*<\/title>/, 'the title names the channel and the day (streamers reuse stream titles)');
        assert.ok(r.text.includes('preload="metadata"'));
        assert.ok(r.text.includes('playsinline'));
        assert.ok(r.text.includes('data-ovv-video'));
        // The network's player (openvibe-shared player.js/css): marked, and both files load on the page.
        assert.ok(/<video class="ovv-player" data-ov-player controls /.test(r.text), 'the video takes the network player');
        assert.ok(/<link rel="stylesheet" href="\/shared\/player\.css\?v=[0-9a-f]+">/.test(r.text) && /<script src="\/shared\/player\.js\?v=[0-9a-f]+" defer><\/script>/.test(r.text), 'player.css and player.js load');
        assert.ok(r.text.includes('data-ovv-view="https://openvibe.live/api/views/vod/101"'), 'playback counts a view on Live');
        const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'VideoObject');
        assert.ok(ld, 'a VideoObject');
        assert.strictEqual(ld.url, 'https://openvibe.video/v/101');
        assert.strictEqual(ld.name, 'A public recording');
        assert.strictEqual(ld.uploadDate, '2026-10-12T10:00:00.000Z');
        assert.strictEqual(ld.duration, 'PT45S');
        assert.deepStrictEqual(ld.thumbnailUrl, ['https://openvibe.media/t/101.jpg']);
        assert.strictEqual(ld.contentUrl, 'https://openvibe.media/v/101?raw=1', 'Media answers bots a page without ?raw=1');
        assert.deepStrictEqual(ld.author, { '@type': 'Person', name: 'Streamer', url: 'https://openvibe.video/@streamer' });
        assert.ok(Array.isArray(ld.hasPart) && ld.hasPart.length >= 1 && ld.hasPart.every((c) => c['@type'] === 'Clip' && Number.isInteger(c.startOffset) && c.url.startsWith('https://openvibe.video/v/101?t=')), 'chapters as key moments');
        assert.match(r.text, /<meta property="og:image" content="https:\/\/openvibe\.media\/t\/101\.jpg"/, 'the thumbnail is the share image');
        assert.ok(r.text.includes('data-ovv-hls="https://openvibe.media/o/med_101/master.m3u8"'), 'the timeline playlist');
        assert.ok(/data-ovv-hls-lib="\/vendor\/hls\.light\.min\.js\?v=[0-9a-f]{10}"/.test(r.text), 'hls.js, self-hosted and content-hashed');
        assert.ok(/media-src[^;]*blob:/.test(String(r.headers['content-security-policy'])), 'MSE plays from blob:');
        assert.ok(/connect-src[^;]*https:\/\/openvibe\.live/.test(String(r.headers['content-security-policy'])), 'the beacon may reach Live');
        assert.ok(r.text.includes('kind="captions"') && r.text.includes('src="/v/101/captions.vtt"'), 'the transcript track');
        assert.ok(r.text.includes('kind="chapters"') && r.text.includes('src="/v/101/chapters.vtt"'), 'the chapters track');
        assert.ok(r.text.includes('Chapters'));
        assert.ok(r.text.includes('Transcript'));
        assert.ok(r.text.includes('A public overview'));
        assert.ok(r.text.includes('/@streamer'));
        assert.ok(!r.text.includes('Manage this recording'), 'owner tools only for the channel (video-owner.test.js)');
        assert.ok(r.text.includes('Discuss on OpenVibe.Community'));
        assert.ok(r.text.includes('data-ovv-chapter'));
        assert.ok(r.text.includes('data-ovv-seek'));
    });

    await check('the clip watch page attributes its maker and links the full recording', async () => {
        const r = await getVideo('/c/201');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('data-ovv-view="https://openvibe.live/api/views/clip/201"'), 'playback counts a clip view on Live');
        const cld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1])).find((x) => x['@type'] === 'VideoObject');
        assert.ok(cld && cld.url === 'https://openvibe.video/c/201', 'a clip VideoObject');
        assert.deepStrictEqual(cld.isPartOf, { '@type': 'VideoObject', url: 'https://openvibe.video/v/101' }, 'part of its recording');
        assert.strictEqual(cld.duration, 'PT10S');
        assert.ok(r.text.includes('src="https://openvibe.media/c/201"'), 'the clip playback url');
        assert.ok(r.text.includes('Made by Clipper'), 'attributed to the person who made it');
        assert.ok(r.text.includes('Watch in the full recording'));
        assert.ok(r.text.includes('/v/101?t=5'), 'the full recording link carries the clip start');
        assert.ok(r.text.includes('Discuss on OpenVibe.Community'));
        assert.ok(!r.text.includes('Manage this clip'), 'owner tools only for its maker or channel (video-owner.test.js)');
    });

    await check('an unlisted VOD is reachable but noindex', async () => {
        const r = await getVideo('/v/102');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('An unlisted recording'));
        assert.ok(!r.text.includes('data-ovv-hls='), 'a playlist on another origin than the file is not used');
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
        assert.match(r.text, /<img src="[^"]*\/avatar\/streamer" alt="" loading="lazy">/, 'the person\'s picture over the letter');
    });

    await check('an unknown /api path on the video host is a JSON 404, not a page', async () => {
        const r = await getVideo('/api/nope');
        assert.strictEqual(r.status, 404);
        assert.match(String(r.headers['content-type']), /json/);
    });

    await check('a name nobody has, with nothing to show, is a 404 (not an empty channel page)', async () => {
        const r = await getVideo('/@nobody_here_x9');
        assert.strictEqual(r.status, 404);
        assert.ok(!r.text.includes('No recordings yet'));
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

    await check('the navbar names the site\'s places: Videos, Upload, Record, Your videos and Playlists, the current one active', async () => {
        const home = (await getVideo('/')).text;
        assert.match(home, /"links":\[\{"label":"Videos","href":"\/","active":true\},\{"label":"Upload","href":"\/upload","active":false\},\{"label":"Record","href":"\/record","active":false\},\{"label":"Your videos","href":"\/me\/videos","active":false\},\{"label":"Playlists","href":"\/playlists","active":false\}\]/);
        assert.ok(home.includes('href="/playlists"'), 'the no-JS nav links Playlists too');
    });

    await check('/updates: the shared update log on the video host, one heading, in the sitemap', async () => {
        const r = await getVideo('/updates');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('<h1>What shipped on OpenVibe.Video</h1>') && r.text.includes('data-ov-shipped="log" data-service="media-hub"'));
        assert.strictEqual((r.text.match(/<h1[\s>]/g) || []).length, 1);
        assert.match(r.text, /<script src="\/shared\/shipped\.js\?v=[0-9a-f]+" defer><\/script>/);
        assert.match((await getVideo('/sitemap.xml')).text, /<loc>[^<]+\/updates<\/loc>/);
    });

    await check('the sitemap lists public items and leaves the unlisted VOD out', async () => {
        const r = await getVideo('/sitemap.xml');
        assert.match(r.text, /<loc>https:\/\/openvibe\.video\/<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/, 'the home, dated by the newest item');
        assert.match(r.text, /<loc>https:\/\/openvibe\.video\/v\/101<\/loc><lastmod>2026-10-12<\/lastmod>/, 'a recording, dated');
        assert.match(r.text, /<loc>https:\/\/openvibe\.video\/@streamer<\/loc>/, 'its channel');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('https://openvibe.video/v/101'));
        assert.ok(r.text.includes('https://openvibe.video/c/201'));
        assert.ok(!r.text.includes('/v/102'));
    });

    await check('a recording nobody wrote about gets a description of its own, not the site tagline', async () => {
        const r = await getVideo('/v/104');
        assert.strictEqual(r.status, 200);
        const want = 'Stream recording by @streamer on OpenVibe.Live: 5 minutes, Oct 12, 2026. Watch with AI captions and chapters on OpenVibe.Video.';
        assert.ok(r.text.includes(`<meta name="description" content="${want}">`), r.text.slice(0, 1500));
        assert.ok(!r.text.includes('content="noindex'), 'five minutes is indexable');
        const clip = await getVideo('/c/201');
        assert.ok(clip.text.includes('<meta name="description" content="A clip overview">'), 'written text still wins');
    });

    await check('a short recording with nothing written about it is noindex and out of the sitemap', async () => {
        const r = await getVideo('/v/106');
        assert.strictEqual(r.status, 200, 'it still plays');
        assert.ok(r.text.includes('<meta name="robots" content="noindex">'));
        assert.ok(r.text.includes('content="Stream recording by @streamer on OpenVibe.Live: 20 seconds, Oct 12, 2026.'));
        const map = (await getVideo('/sitemap.xml')).text;
        assert.ok(!map.includes('/v/110<'), 'the 10-second feed item with no text is left out');
        assert.ok(map.includes('/v/109<'), 'a short one with a description stays');
    });

    await check('the sitemap carries a video entry for each listed recording and clip', async () => {
        const map = (await getVideo('/sitemap.xml')).text;
        assert.ok(map.includes('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"'));
        assert.ok(map.includes('<loc>https://openvibe.video/v/101</loc><lastmod>2026-10-12</lastmod><video:video><video:thumbnail_loc>https://openvibe.media/t/101.jpg</video:thumbnail_loc>'
            + '<video:title>A public recording</video:title><video:description>A public stream</video:description>'
            + '<video:content_loc>https://openvibe.media/v/101?raw=1</video:content_loc><video:duration>45</video:duration><video:view_count>100</video:view_count>'
            + '<video:publication_date>2026-10-12T10:00:00.000Z</video:publication_date><video:uploader info="https://openvibe.video/@streamer">streamer</video:uploader></video:video></url>'), map);
        assert.ok(map.includes('<loc>https://openvibe.video/c/201</loc><lastmod>2026-10-12</lastmod></url>'), 'a clip without a thumbnail has no video entry');
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

    await check('an answer whose playback_url is the playlist plays the file_url as the file, with the playlist for hls.js', async () => {
        const r = await getVideo('/v/105');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('src="https://openvibe.media/v/105"'), 'the file is the <video> source');
        assert.ok(r.text.includes('data-ovv-hls="https://openvibe.media/o/med_105/master.m3u8"'));
        assert.ok(r.text.includes('"contentUrl":"https://openvibe.media/v/105?raw=1"'), 'contentUrl is the file');
    });

    await check('the VOD page lists the chat replay with offsets, escaping and no private fields', async () => {
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Chat replay'));
        assert.ok(r.text.includes('data-ovv-at="5"'), 'the first message is 5 seconds in');
        assert.ok(r.text.includes('data-ovv-seek="5"'), 'the seek button carries the offset');
        assert.ok(r.text.includes('0:00:05'), 'the offset is H:MM:SS');
        assert.ok(r.text.includes('data-ovv-at="25"'), 'the second message is 25 seconds in');
        assert.ok(r.text.includes('0:00:25'));
        assert.ok(r.text.includes('Hello &lt;b&gt;world&lt;/b&gt;'), 'message text is escaped');
        assert.ok(!r.text.includes('Hello <b>world</b>'), 'raw HTML never appears');
        assert.ok(!r.text.includes('EARLY_MSG_XYZ'), 'message before the stream start is dropped');
        assert.ok(!r.text.includes('DELETED_MSG_XYZ'), 'deleted message is dropped');
        assert.ok(!r.text.includes('FILTERED_MSG_XYZ'), 'filtered message is dropped');
        assert.ok(!r.text.includes('SYSTEM_MSG_XYZ'), 'non-chat message is dropped');
        assert.ok(!r.text.includes('LATE_MSG_XYZ'), 'message after the end + 60 s is dropped');
        assert.ok(!r.text.includes('anon-PRIVATE'), 'anon ids never render');
        assert.ok(!r.text.includes('meta-PRIVATE'), 'metadata never renders');
        assert.ok(!r.text.includes('PRIVATE-COLOR'), 'colours never render');
        assert.ok(!r.text.includes('PRIVATE-ROLE'), 'roles never render');
        assert.ok(!r.text.includes('900002'), 'user ids never render');
        assert.ok(!r.text.includes('user_id'), 'user id field never renders');
    });

    await check('the chat replay caps at 1,000 messages and says how many were left out', async () => {
        const r = await getVideo('/v/104');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Showing the first 1,000 messages; 5 more not shown.'), 'the cap note names the count');
        assert.strictEqual(countOccurrences(r.text, 'class="ovv-chat-row"'), 1000, 'exactly 1,000 rows render');
    });

    await check('the VOD page shows the newest comments and the Community link', async () => {
        const r = await getVideo('/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Comments'));
        assert.ok(r.text.includes('Commenter'), 'author display name');
        assert.ok(r.text.includes('other_user'), 'username fallback for the author');
        assert.ok(r.text.includes('Nice &lt;b&gt;stream&lt;/b&gt;!'), 'comment text is escaped');
        assert.ok(!r.text.includes('Nice <b>stream</b>!'), 'raw comment HTML never appears');
        assert.ok(r.text.includes('3 replies'), 'reply count when present');
        assert.ok(r.text.includes('<time class="ovv-comment-date"'), 'a relative date is shown');
        assert.strictEqual(countOccurrences(r.text, 'class="ovv-comment"'), 2, 'the deleted comment is not rendered');
        assert.ok(r.text.includes('Join the discussion on OpenVibe.Community'));
        assert.ok(r.text.includes('href="https://openvibe.community/t/vod-101"'));
    });

    await check('a VOD with no comments shows the empty line and the link', async () => {
        const r = await getVideo('/v/102');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('No comments yet.'));
        assert.ok(r.text.includes('href="https://openvibe.community/t/vod-102"'));
    });

    await t.close();
    await live.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
