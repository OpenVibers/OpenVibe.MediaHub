'use strict';
/**
 * OpenVibe.Video "Make a clip": any signed-in viewer of a finished recording cuts a clip on OpenVibe.Live (Live's
 * POST /api/vods/clips, as the person, with their own address for Live's per-address cooldown); times are m:ss,
 * h:mm:ss or seconds, checked before Live is called; the new clip's page says it is being cut until Media is done.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const usernameOf = (auth) => {
    const tok = String(auth || '').replace(/^Bearer /, '');
    try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).username || null; } catch { return null; }
};

function startLive() {
    const vod = { id: 101, title: 'A long stream', description: '', duration_seconds: 3600, created_at: '2026-10-12T10:00:00.000Z', playback_url: 'https://openvibe.media/v/101', visibility: 'public', username: 'kim', display_name: 'Kim' };
    const clips = {};
    const calls = [];
    let refuse = null;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            if (req.method === 'POST' && url.pathname === '/api/vods/clips') {
                const body = JSON.parse(raw || '{}');
                calls.push({ who: usernameOf(req.headers.authorization), xff: req.headers['x-forwarded-for'] || null, body });
                if (refuse) return json(refuse.status, { error: refuse.error });
                const clip = { id: 301, vod_id: body.vod_id, title: body.title || 'Clip', start_time: body.start_time, end_time: body.end_time, duration_seconds: body.end_time - body.start_time, status: 'processing', visibility: 'public', username: usernameOf(req.headers.authorization), playback_url: 'https://openvibe.media/c/301', created_at: '2026-10-12T21:00:00.000Z' };
                clips[301] = clip;
                return json(201, { clip });
            }
            if (url.pathname === '/api/vods/101') return json(200, { vod, clips: [] });
            const c = /^\/api\/clips\/(\d+)$/.exec(url.pathname);
            if (c) return clips[c[1]] ? json(200, { clip: clips[c[1]] }) : json(404, { error: 'not found' });
            return json(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, clips, calls, refuse: (r) => { refuse = r; }, close: () => new Promise((r) => server.close(r)) })));
}

function vreq(base, path, { method = 'GET', cookie, form, same = true } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: 'openvibe.video' };
        if (cookie) h.cookie = cookie;
        if (same && method !== 'GET') h['sec-fetch-site'] = 'same-origin';
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

    await check('signed out, the panel offers sign-in; signed in, the form', async () => {
        const anon = await vreq(t.base, '/v/101');
        assert.ok(/<a class="ovv-btn" href="\/auth\/login\?next=%2Fv%2F101" title="Sign in to make a clip of up to 60 seconds">[^<]*<i class="fa-solid fa-scissors"/.test(anon.text), 'the Clip button signs in first');
        assert.ok(!anon.text.includes('action="/v/101/clip"'));
        const r = await vreq(t.base, '/v/101', { cookie: samCookie });
        assert.ok(r.text.includes('action="/v/101/clip"'), 'any signed-in viewer, not only the channel');
        assert.ok(r.text.includes('within 1:00:00'), 'the recording length');
        assert.ok(r.text.includes('data-ovv-clip-now'), 'the Start here / End here buttons (shown by the script)');
        // Owner, 2026-10-27: the times start where the video is, and an empty title is named by AI (said on the form).
        assert.ok(r.text.includes('data-ovv-clip-duration="3600"'), 'the script keeps the times inside the video');
        assert.ok(r.text.includes('placeholder="Leave empty: AI names it"') && r.text.includes('With no title, AI names the clip from what happens and what is said in it'));
        const js = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'video.js'), 'utf8');
        assert.ok(js.includes("clipper.addEventListener('toggle'") && js.includes('Math.floor(video.currentTime || 0)'), 'opening the menu starts at the current time');
        assert.ok(js.includes('if (!clipper.open || typed) return;'), 'times the person typed are kept');
    });

    await check('a clip is made on Live as the person, with their address, then its page says it is being cut', async () => {
        const r = await vreq(t.base, '/v/101/clip', { method: 'POST', cookie: samCookie, form: { start: '1:05', end: '1:35', title: 'The good part' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.strictEqual(r.headers.location, '/c/301?made=1');
        const call = live.calls.pop();
        assert.strictEqual(call.who, 'sam');
        assert.deepStrictEqual(call.body, { vod_id: 101, start_time: 65, end_time: 95, title: 'The good part' });
        assert.ok(call.xff, 'the viewer\'s address is passed for Live\'s per-address limit');
        const page = await vreq(t.base, '/c/301?made=1', { cookie: samCookie });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('Your clip was made'), 'a made notice');
        assert.ok(page.text.includes('This clip is being cut') && page.text.includes('data-ovv-reload="8"'), 'cutting, and the page looks again');
        assert.ok(!page.text.includes('<video'), 'no player before there is a file');
        live.clips[301].status = 'ready';
        const ready = await vreq(t.base, '/c/301', { cookie: samCookie });
        assert.ok(ready.text.includes('<video') && !ready.text.includes('being cut'), 'the player once it is ready');
    });

    await check('times are checked before Live is called', async () => {
        const before = live.calls.length;
        for (const form of [{ start: 'abc', end: '0:30' }, { start: '0:30', end: '0:30' }, { start: '0:40', end: '0:10' }, { start: '0:00', end: '1:01' }, { start: '1:99', end: '2:10' }]) {
            const r = await vreq(t.base, '/v/101/clip', { method: 'POST', cookie: samCookie, form });
            assert.strictEqual(r.status, 422, JSON.stringify(form));
        }
        assert.strictEqual((await vreq(t.base, '/v/101/clip', { method: 'POST', cookie: samCookie, same: false, form: { start: '0:00', end: '0:10' } })).status, 403, 'cross-site');
        assert.strictEqual((await vreq(t.base, '/v/101/clip', { method: 'POST', form: { start: '0:00', end: '0:10' } })).status, 401, 'signed out');
        assert.strictEqual(live.calls.length, before, 'Live was never called');
        const r = await vreq(t.base, '/v/101/clip', { method: 'POST', cookie: samCookie, form: { start: '3600', end: '3610.5' } });
        assert.strictEqual(r.status, 303, 'plain seconds work too');
        assert.deepStrictEqual(live.calls.pop().body, { vod_id: 101, start_time: 3600, end_time: 3610.5 });
    });

    await check('Live\'s refusal is shown as it is', async () => {
        live.refuse({ status: 429, error: 'You are clipping too fast. Please wait 10 seconds before making another clip.' });
        const r = await vreq(t.base, '/v/101/clip', { method: 'POST', cookie: samCookie, form: { start: '0:00', end: '0:10' } });
        assert.strictEqual(r.status, 403);
        assert.ok(r.text.includes('OpenVibe.Live said: You are clipping too fast'), r.text.slice(0, 400));
        live.refuse(null);
    });

    await t.close();
    await live.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
