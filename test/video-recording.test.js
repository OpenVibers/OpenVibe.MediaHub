'use strict';
/**
 * A stream recorded in parts is one video on openvibe.video (owner, 2026-10-27: "instead of 'The stream was recorded in
 * 2 parts: Part 1 (this one) · Part 2' it should automatically just have them as a single vod … that seeks just fine").
 * Once Live answers a joined recording (OpenVibe.Media docs/recordings.md):
 * - a later part's page sends people to the whole video at the second it starts (301, ?t carried over);
 * - the whole video's page plays the joined playlist, says no "Part 1 · Part 2", shows the whole length;
 * - its chat replay is every part's, in the video's time (the gap between parts left out);
 * - its Download menu offers one file per recorded session, named by where it sits in the video;
 * - its clip form sends recording_time, so the clip is placed on the recording (across a join too).
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const usernameOf = (auth) => {
    const tok = String(auth || '').replace(/^Bearer /, '');
    try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).username || null; } catch { return null; }
};

function startLive() {
    const parts = [{ vod_id: 6025, start_sec: 0, duration_sec: 678, gap_before_sec: 0, stream_offset_sec: 28 },
        { vod_id: 6026, start_sec: 678, duration_sec: 1221, gap_before_sec: 3, stream_offset_sec: 709 }];
    const recording = { id: 'med_REC', vod_id: 6025, joined: true, duration_seconds: 1899, start_sec: 0, parts };
    const vods = {
        6025: { id: 6025, stream_id: 2795, title: 'BIRD DRAMA', description: '', duration_seconds: 1899, part_duration_seconds: 678, created_at: '2026-10-26T20:54:07.000Z',
            stream_started_at: '2026-10-26 20:53:39', stream_ended_at: '2026-10-26 21:26:00', stream_offset_sec: 28,
            playback_url: 'https://openvibe.media/v/6025', file_url: 'https://openvibe.media/v/6025', file_path: 'vod_6025.mp4',
            hls_url: 'https://openvibe.media/o/med_REC/master.m3u8', visibility: 'public', username: 'Maticus', display_name: 'Maticus', recording },
        6026: { id: 6026, stream_id: 2795, title: 'BIRD DRAMA (Part 2)', duration_seconds: 1221, created_at: '2026-10-26T21:05:28.000Z', part: 2,
            playback_url: 'https://openvibe.media/v/6026', file_url: 'https://openvibe.media/v/6026', visibility: 'public', username: 'Maticus', display_name: 'Maticus',
            recording: { ...recording, start_sec: 678 } },
    };
    const at = (sec) => new Date(Date.parse('2026-10-26T20:53:39Z') + sec * 1000).toISOString();
    const messages = [
        { message_type: 'chat', timestamp: at(100), username: 'a', display_name: 'A', message: 'in part one' },
        { message_type: 'chat', timestamp: at(707.5), username: 'b', display_name: 'B', message: 'in the gap' },
        { message_type: 'chat', timestamp: at(720), username: 'c', display_name: 'C', message: 'in part two' },
    ];
    const calls = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            calls.push({ method: req.method, path: url.pathname + url.search, who: usernameOf(req.headers.authorization), body: raw ? JSON.parse(raw) : null });
            const v = /^\/api\/vods\/(\d+)$/.exec(url.pathname);
            if (v && req.method === 'GET') return vods[v[1]] ? json(200, { vod: vods[v[1]], clips: [] }) : json(404, { error: 'not found' });
            if (url.pathname === '/api/chat/2795/replay') return json(200, { messages });
            const d = /^\/api\/vods\/(\d+)\/download-url$/.exec(url.pathname);
            if (d) return json(200, { url: `https://openvibe.media/v/${d[1]}?download=1&name=${encodeURIComponent(url.searchParams.get('name') || '')}` });
            if (req.method === 'POST' && url.pathname === '/api/vods/clips') return json(201, { clip: { id: 701, vod_id: 6025, status: 'ready' } });
            return json(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) })));
}

function vreq(base, path, { method = 'GET', cookie, form } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: 'openvibe.video' };
        if (cookie) h.cookie = cookie;
        if (method !== 'GET') h['sec-fetch-site'] = 'same-origin';
        let data;
        if (form) { data = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; h['content-length'] = data.length; }
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url } });
    const sam = t.network.addUser('sam');
    const samCookie = t.signIn(sam);

    await check('a later part sends people to the whole video at its second', async () => {
        let r = await vreq(t.base, '/v/6026');
        assert.strictEqual(r.status, 301);
        assert.strictEqual(r.headers.location, '/v/6025?t=678');
        r = await vreq(t.base, '/v/6026?t=10&list=pl_1');
        assert.strictEqual(r.headers.location, '/v/6025?t=688&list=pl_1', '?t into the part is carried over');
    });

    await check('the whole video plays the joined playlist, with no "Part 1 · Part 2"', async () => {
        const r = await vreq(t.base, '/v/6025');
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('data-ovv-hls="https://openvibe.media/o/med_REC/master.m3u8"'), 'the recording\'s playlist');
        assert.ok(!/recorded in \d parts/.test(r.text), 'no parts line');
        assert.ok(r.text.includes('31:39'), 'the whole length');
    });

    await check('chat replay: every part, in the video\'s time, the gap left out', async () => {
        const r = await vreq(t.base, '/v/6025/download/chat.json');
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        const got = JSON.parse(r.text).messages.map((m) => [m.seconds, m.message]);
        assert.deepStrictEqual(got, [[72, 'in part one'], [689, 'in part two']], JSON.stringify(got));
    });

    await check('Download: one file per recorded session, named by where it sits', async () => {
        const page = (await vreq(t.base, '/v/6025')).text;
        assert.ok(page.includes('2 files, one per recorded session'));
        assert.ok(page.includes('href="/v/6025/download/video?part=6025"') && page.includes('href="/v/6025/download/video?part=6026"'));
        assert.ok(page.includes('>0:00–11:18<') && page.includes('>11:18–31:39<'), 'labelled by time');
        const r = await vreq(t.base, '/v/6025/download/video?part=6026');
        assert.strictEqual(r.status, 302);
        assert.ok(r.headers.location.startsWith('https://openvibe.media/v/6026?download=1&name=BIRD%20DRAMA') && r.headers.location.endsWith('%20-%20part%202'), r.headers.location);
        assert.strictEqual((await vreq(t.base, '/v/6025/download/video?part=999')).status, 404, 'only the recording\'s own parts');
    });

    await check('the clip form sends recording_time, so the clip is placed on the whole video', async () => {
        const page = (await vreq(t.base, '/v/6025', { cookie: samCookie })).text;
        assert.ok(page.includes('<input type="hidden" name="recording_time" value="1">'));
        const r = await vreq(t.base, '/v/6025/clip', { method: 'POST', cookie: samCookie, form: { start: '11:10', end: '11:30', recording_time: '1' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 200));
        const call = live.calls.filter((c) => c.method === 'POST' && c.path === '/api/vods/clips').pop();
        assert.deepStrictEqual(call.body, { vod_id: 6025, start_time: 670, end_time: 690, recording_time: 1 });
    });

    await t.close();
    await live.close();
    done();
})();
