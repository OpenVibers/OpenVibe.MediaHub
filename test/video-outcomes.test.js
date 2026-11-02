'use strict';
/**
 * OpenVibe.Video, the market outcomes of 2026-10-30 (research/outcomes/video.md), on the watch pages:
 *
 *   1  the page says what the video is: a stream recording, a clip or an upload, the day it was streamed, its length
 *   2  a clip credits the recording it was cut from and links back to it
 *   3  a plain timestamp link: the page's own address, with a time on it (a moment, not a clip, nothing stored)
 *   7  the exports say what they are for, and the transcript says it was written by AI
 *
 * Every number on the page comes from Live's own answer (or the upload's own row): the page never says a day, a length
 * or a count it was not given. Live is a stub here, so each fact can be checked against the stub.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

/** A request with Host: openvibe.video (Node's fetch drops a Host header). */
function videoClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.video', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        req.end();
    });
}

/** OpenVibe.Live, as a stub: one recording with a stream time, one without, and two clips. */
function startLive() {
    const recording = {
        id: 501, title: 'A long recording', description: 'A stream', duration_seconds: 754,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/501.jpg',
        file_url: 'https://openvibe.media/v/501', playback_url: 'https://openvibe.media/v/501', visibility: 'public',
        username: 'streamer', display_name: 'Streamer', view_count: 1204, is_recording: false,
        ai_overview: 'An overview.', stream_category: 'Gaming', stream_id: 9001,
        stream_started_at: '2026-10-12 09:30:00', stream_ended_at: '2026-10-12 09:42:34',
        ai_transcript_json: [{ start: 0, end: 2, text: 'Hello there.' }, { start: 2, end: 4, text: 'And again.' }],
    };
    // A recording from before Live kept the stream's own times: it has no day to be streamed on.
    const oldRecording = {
        ...recording, id: 502, title: 'An older recording', stream_started_at: null, stream_id: null,
        duration_seconds: 45, view_count: 0, ai_overview: '', ai_transcript_json: null,
    };
    const clip = {
        id: 601, vod_id: 501, title: 'A clip of it', start_time: 65, end_time: 95, duration_seconds: 30,
        file_url: 'https://openvibe.media/c/601', playback_url: 'https://openvibe.media/c/601', visibility: 'public',
        auto_generated: false, username: 'clipper', display_name: 'Clipper', created_at: '2026-10-13T09:00:00.000Z',
        source_streamer_username: 'streamer', source_streamer_display_name: 'Streamer', ai_overview: 'A clip overview',
        view_count: 20,
    };
    // A clip whose recording is not public any more (Live answers 404 for it).
    const orphanClip = { ...clip, id: 602, vod_id: 999, title: 'A clip of a private recording' };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        const json = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        const vod = /^\/api\/vods\/(\d+)$/.exec(p);
        if (vod) {
            if (vod[1] === '501') return json(200, { vod: recording, clips: [] });
            if (vod[1] === '502') return json(200, { vod: oldRecording, clips: [] });
            return json(404, { error: 'not found' });
        }
        const cl = /^\/api\/clips\/(\d+)$/.exec(p);
        if (cl) {
            if (cl[1] === '601') return json(200, { clip });
            if (cl[1] === '602') return json(200, { clip: orphanClip });
            return json(404, { error: 'not found' });
        }
        if (/^\/api\/vods\/\d+\/memories$/.test(p)) return json(200, { memories: [{ offset_seconds: 10, description: 'The start' }] });
        if (/^\/api\/comments\/(vod|clip)\/\d+$/.test(p)) return json(200, { comments: [], total: 0, thread: { id: 'thr', url: 'https://openvibe.community/t/x' } });
        if (/^\/api\/chat\/\d+\/replay$/.test(p)) return json(200, { messages: [
            { id: 'm1', timestamp: '2026-10-12 09:31:00', username: 'viewer', display_name: 'Viewer', message: 'Hello', message_type: 'chat' },
            { id: 'm2', timestamp: '2026-10-12 09:32:00', username: 'viewer2', display_name: 'Viewer Two', message: 'Again', message_type: 'chat' },
        ] });
        if (p === '/api/streams') return json(200, { streams: [] });
        if (p === '/api/content/feed') return json(200, { items: [], next: null });
        if (p === '/api/vods' || p === '/api/clips') return json(200, { vods: [], clips: [], total: 0, hasMore: false });
        if (p === '/api/v1/search') return json(200, { results: [] });
        return json(404, { error: 'not found' });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => server.close(r)),
        }));
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
    const get = videoClient(t);
    try {
        await check('outcome 1: a recording says what it is: a stream recording, the day, the length, the views', async () => {
            const r = await get('/v/501');
            assert.strictEqual(r.status, 200);
            const what = /<p class="ovv-what">([\s\S]*?)<\/p>/.exec(r.text);
            assert.ok(what, 'the page says what the video is');
            const line = what[1];
            assert.ok(line.includes('Stream recording'), line);
            assert.ok(line.includes('Streamed on') && line.includes('Oct 12, 2026'), 'the day it was streamed: ' + line);
            assert.ok(line.includes('13 minutes'), 'its length, in words: ' + line);
            assert.ok(line.includes('1,204 views'), 'its views: ' + line);
            assert.ok(/<time datetime="2026-10-12T09:30:00.000Z">/.test(line), 'the day in a machine-readable time: ' + line);
            // The channel is in the byline under it, and the category in About: nothing is said twice.
            assert.ok(r.text.includes('class="ovv-channel-name"') && r.text.includes('@Streamer'), 'the channel');
            assert.ok(r.text.includes("Streamed live on") && r.text.includes('in Gaming'), 'the category is in About');
        });

        await check('outcome 1: a recording with no stream time says when it was published, and guesses nothing', async () => {
            const r = await get('/v/502');
            assert.strictEqual(r.status, 200);
            const line = /<p class="ovv-what">([\s\S]*?)<\/p>/.exec(r.text)[1];
            assert.ok(line.includes('Published on') && line.includes('Oct 12, 2026'), line);
            assert.ok(!line.includes('Streamed on'), 'no day it was streamed: Live never said one');
            assert.ok(!line.includes('views'), 'no views: Live counted none');
            assert.ok(line.includes('45 seconds'), 'the length it does have: ' + line);
        });

        await check('outcome 1: a clip says what it is, and an upload says it is an upload', async () => {
            const clip = await get('/c/601');
            const line = /<p class="ovv-what">([\s\S]*?)<\/p>/.exec(clip.text)[1];
            assert.ok(line.includes('Clip</span>') && !line.includes('AI clip'), 'a clip: ' + line);
            assert.ok(line.includes('30 seconds') && line.includes('20 views'), line);
            // The upload's own row: the day it was uploaded, its length and its views.
            const s = t.ctx.s;
            const id = 'vup_01J0000000000000000000000B';
            t.media.vods.set(950, { id: 950, title: 'A home video', visibility: 'public', bytes: 1000, types: ['video/mp4'], status: 'ready' });
            await s.db.exec(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at, duration_seconds, views)
                             VALUES ($1, 'user:nobody', 'kim', 'A home video', '', 'public', 950, 'video/mp4', 1000, 1000, 1, 1, 'ready', 'active', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', 125, 0)`,
            [id]);
            const up = await get(`/u/${id}`);
            assert.strictEqual(up.status, 200);
            const uline = /<p class="ovv-what">([\s\S]*?)<\/p>/.exec(up.text)[1];
            assert.ok(uline.includes('Upload') && uline.includes('Uploaded on') && uline.includes('Oct 20, 2026'), uline);
            assert.ok(uline.includes('2 minutes'), 'its length: ' + uline);
        });

        await check('outcome 2: a clip credits the recording it was cut from and links back to it', async () => {
            const r = await get('/c/601');
            const credit = /<p class="ovv-source">([\s\S]*?)<\/p>/.exec(r.text);
            assert.ok(credit, 'the clip credits its source');
            const line = credit[1];
            assert.ok(line.includes('Cut from'), line);
            assert.ok(line.includes('A long recording'), 'the title of the recording it came from: ' + line);
            assert.ok(line.includes('href="/v/501?t=65"'), 'a link back to the recording, at the clip\'s moment: ' + line);
            assert.ok(line.includes("Streamer's stream recording"), 'whose recording it was: ' + line);
            assert.ok(line.includes('starts at 1:05 in it'), 'where the clip starts in it: ' + line);
        });

        await check('outcome 2: a clip whose recording is not public says so, and names nothing it cannot know', async () => {
            const r = await get('/c/602');
            assert.strictEqual(r.status, 200);
            const line = /<p class="ovv-source">([\s\S]*?)<\/p>/.exec(r.text)[1];
            assert.ok(line.includes('not public any more'), line);
            assert.ok(!line.includes('A long recording'), 'no title from a recording we cannot see');
        });

        await check('outcome 3: the page carries a plain link, and says how to make a link to a moment', async () => {
            const r = await get('/v/501');
            const field = /<input class="ovv-share-url"[^>]*value="([^"]*)"/.exec(r.text);
            assert.ok(field, 'the link is written out on the page');
            assert.strictEqual(field[1], 'https://openvibe.video/v/501');
            const panel = r.text.slice(r.text.indexOf('ovv-share'), r.text.indexOf('</details>', r.text.indexOf('ovv-share')));
            assert.ok(panel.includes('?t=125'), 'the panel says how to link to a moment: ' + panel);
            assert.ok(panel.includes('nothing is stored'), 'a moment is not a clip: ' + panel);
            assert.ok(panel.includes('data-ovv-share-at="https://openvibe.video/v/501"'), 'the button that copies the link at the moment it plays');
            // The page opened at a moment: the field shows that link.
            const at = await get('/v/501?t=125');
            assert.strictEqual(/<input class="ovv-share-url"[^>]*value="([^"]*)"/.exec(at.text)[1], 'https://openvibe.video/v/501?t=125');
            // An upload's watch page carries the same plain link.
            const up = await get('/u/vup_01J0000000000000000000000B');
            assert.strictEqual(up.status, 200);
            assert.ok(/<input class="ovv-share-url"[^>]*value="https:\/\/openvibe\.video\/u\/vup_01J0000000000000000000000B"/.test(up.text), 'the upload page has the link too');
        });

        await check('outcome 7: every export says what it is for, and the transcript says it was written by AI', async () => {
            const r = await get('/v/501');
            const menu = r.text.slice(r.text.indexOf('<details class="ovv-dl"'), r.text.indexOf('</details>', r.text.indexOf('<details class="ovv-dl"')));
            assert.ok(menu.includes('Transcript') && menu.includes('2 lines, written by AI'), 'the transcript says it is AI-made');
            for (const [ext, why] of [['TXT', 'to read'], ['SRT', 'for editors'], ['VTT', 'for web players'], ['JSON', 'for programs']]) {
                assert.ok(new RegExp(`<span>${ext}</span><small>${why}</small>`).test(menu), `${ext} says what it is for (${why})`);
            }
            // The chat replay's own exports: the same, in its own menu.
            const chat = /<a class="ovv-mini-item"[^>]*href="\/v\/501\/download\/chat\.csv"[\s\S]*?<\/a>/.exec(r.text);
            assert.ok(chat, 'the chat replay is exported as a spreadsheet');
            assert.ok(/Opens in Excel or Sheets/.test(chat[0]), 'and says so: ' + chat[0]);
            // The transcript panel itself.
            assert.ok(r.text.includes('Written by AI from the audio'), 'the transcript panel says it was written by AI');
            assert.ok(r.text.includes('data-ovv-tp="transcript"'), 'the transcript panel is there');
        });
    } finally {
        await t.close();
        await live.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
