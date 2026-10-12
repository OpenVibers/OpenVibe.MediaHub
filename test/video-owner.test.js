'use strict';
/**
 * OpenVibe.Video owner tools: a recording's channel (and a clip's maker or channel) gets a Manage panel on the watch
 * page; edits and deletions are made on OpenVibe.Live AS the signed-in person (their Network token as a Bearer), are
 * same-origin web forms, are validated before Live is called, and show Live's own refusal. A private item is shown
 * to its owner only (noindex, private), and Live's answer is re-read after a change (the read cache is dropped).
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const usernameOf = (auth) => {
    const tok = String(auth || '').replace(/^Bearer /, '');
    try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).username || null; } catch { return null; }
};

function startLive() {
    const vods = {
        101: { id: 101, title: 'Kim stream', description: 'First', duration_seconds: 45, created_at: '2026-10-12T10:00:00.000Z', playback_url: 'https://openvibe.media/v/101', visibility: 'public', username: 'kim', display_name: 'Kim' },
        103: { id: 103, title: 'Kim private', description: '', duration_seconds: 20, created_at: '2026-10-12T09:00:00.000Z', playback_url: 'https://openvibe.media/v/103', visibility: 'private', username: 'kim', display_name: 'Kim' },
    };
    const clips = {
        201: { id: 201, vod_id: 101, title: 'Kim clip', start_time: 5, end_time: 15, duration_seconds: 10, playback_url: 'https://openvibe.media/c/201', visibility: 'public', username: 'kim', display_name: 'Kim' },
    };
    const calls = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const who = usernameOf(req.headers.authorization);
        const json = (status, body) => { const t = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(t); };
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            if (req.method !== 'GET') calls.push({ method: req.method, path: url.pathname, who, body });
            const m = /^\/api\/(vods|clips)\/(\d+)(\/title|\/visibility)?$/.exec(url.pathname);
            if (m) {
                const store = m[1] === 'vods' ? vods : clips;
                const item = store[m[2]];
                if (!item) return json(404, { error: 'not found' });
                const owns = who && who === item.username;
                if (req.method === 'GET') {
                    if (item.visibility === 'private' && !owns) return json(404, { error: 'not found' });
                    return json(200, m[1] === 'vods' ? { vod: item, clips: [] } : { clip: item });
                }
                if (!who) return json(401, { error: 'Authentication required' });
                if (!owns) return json(403, { error: 'Not authorized' });
                if (req.method === 'DELETE') { delete store[m[2]]; return json(200, { message: 'deleted' }); }
                Object.assign(item, body);
                return json(200, m[1] === 'vods' ? { vod: item } : { message: 'ok' });
            }
            if (url.pathname === '/api/vods') return json(200, { vods: Object.values(vods).filter((v) => v.visibility === 'public'), hasMore: false });
            if (url.pathname === '/api/clips') return json(200, { clips: Object.values(clips).filter((c) => c.visibility === 'public') });
            return json(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, vods, clips, calls, close: () => new Promise((r) => server.close(r)) })));
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
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimCookie = t.signIn(kim);
    const samCookie = t.signIn(sam);

    await check('only the channel sees the Manage panel', async () => {
        const mine = await vreq(t.base, '/v/101', { cookie: kimCookie });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.text.includes('Manage this recording') && mine.text.includes('action="/v/101/manage"'), 'the owner panel');
        assert.ok(mine.text.includes('value="Kim stream"') && mine.text.includes('<option value="public" selected>'), 'prefilled');
        const other = await vreq(t.base, '/v/101', { cookie: samCookie });
        assert.ok(!other.text.includes('Manage this recording'), 'not for someone else');
        const anon = await vreq(t.base, '/v/101');
        assert.ok(!anon.text.includes('Manage this recording'), 'not signed out');
    });

    await check('an edit is made on Live as the person, then the page shows it', async () => {
        await vreq(t.base, '/v/101');   // warm the read cache
        const r = await vreq(t.base, '/v/101/manage', { method: 'POST', cookie: kimCookie, form: { title: 'Kim renamed', description: 'Second', visibility: 'unlisted' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.strictEqual(r.headers.location, '/v/101?saved=1');
        const call = live.calls.pop();
        assert.deepStrictEqual(call, { method: 'PUT', path: '/api/vods/101', who: 'kim', body: { title: 'Kim renamed', description: 'Second', visibility: 'unlisted' } });
        const after = await vreq(t.base, '/v/101?saved=1', { cookie: kimCookie });
        assert.ok(after.text.includes('Saved on OpenVibe.Live.'), 'a saved notice');
        assert.ok(after.text.includes('<h1 class="ovv-title">Kim renamed</h1>'), 'the cached read was dropped');
    });

    await check('forms are validated, same-origin, and Live\'s refusal is shown', async () => {
        const before = live.calls.length;
        let r = await vreq(t.base, '/v/101/manage', { method: 'POST', cookie: kimCookie, form: { title: '', visibility: 'public' } });
        assert.strictEqual(r.status, 422);
        r = await vreq(t.base, '/v/101/manage', { method: 'POST', cookie: kimCookie, form: { title: 'x', visibility: 'friends' } });
        assert.strictEqual(r.status, 422);
        r = await vreq(t.base, '/v/101/manage', { method: 'POST', cookie: kimCookie, same: false, form: { title: 'x', visibility: 'public' } });
        assert.strictEqual(r.status, 403, 'cross-site');
        r = await vreq(t.base, '/v/101/manage', { method: 'POST', form: { title: 'x', visibility: 'public' } });
        assert.strictEqual(r.status, 401, 'signed out');
        assert.strictEqual(live.calls.length, before, 'Live was never called');
        r = await vreq(t.base, '/v/101/manage', { method: 'POST', cookie: samCookie, form: { title: 'Taken', visibility: 'public' } });
        assert.strictEqual(r.status, 403);
        assert.ok(r.text.includes('OpenVibe.Live said: Not authorized'), r.text.slice(0, 400));
        assert.strictEqual(live.vods[101].title, 'Kim renamed', 'nothing changed');
    });

    await check('a private recording is shown to its owner only, never indexed', async () => {
        assert.strictEqual((await vreq(t.base, '/v/103')).status, 404);
        assert.strictEqual((await vreq(t.base, '/v/103', { cookie: samCookie })).status, 404);
        const r = await vreq(t.base, '/v/103', { cookie: kimCookie });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Private: only you'), 'a private notice');
        assert.ok(r.text.includes('noindex'), 'noindex');
        assert.match(String(r.headers['cache-control']), /private/);
        assert.ok(r.text.includes('Manage this recording'), 'so the owner can make it public again');
    });

    await check('a clip\'s maker changes only what changed; deletes need the box ticked', async () => {
        const n = live.calls.length;
        let r = await vreq(t.base, '/c/201/manage', { method: 'POST', cookie: kimCookie, form: { title: 'Kim clip 2', visibility: 'public' } });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        assert.deepStrictEqual(live.calls.slice(n).map((c) => `${c.method} ${c.path}`), ['PUT /api/clips/201/title'], 'the title only');
        r = await vreq(t.base, '/c/201/manage', { method: 'POST', cookie: kimCookie, form: { title: 'Kim clip 2', visibility: 'unlisted' } });
        assert.deepStrictEqual(live.calls.slice(n + 1).map((c) => `${c.method} ${c.path}`), ['PUT /api/clips/201/visibility']);
        r = await vreq(t.base, '/c/201/delete', { method: 'POST', cookie: kimCookie, form: {} });
        assert.strictEqual(r.status, 422, 'no confirmation');
        r = await vreq(t.base, '/c/201/delete', { method: 'POST', cookie: kimCookie, form: { confirm: '1' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.location, '/@kim?deleted=1');
        assert.ok(!live.clips[201], 'deleted on Live');
    });

    await check('a recording deleted from Video is gone from its channel page', async () => {
        await vreq(t.base, '/@kim');   // warm the list cache
        const r = await vreq(t.base, '/v/101/delete', { method: 'POST', cookie: kimCookie, form: { confirm: '1' } });
        assert.strictEqual(r.status, 303);
        const ch = await vreq(t.base, '/@kim?deleted=1', { cookie: kimCookie });
        assert.ok(ch.text.includes('Deleted on OpenVibe.Live.'), 'a deleted notice');
        assert.ok(!ch.text.includes('/v/101"'), 'the list cache was dropped');
        assert.strictEqual((await vreq(t.base, '/v/101')).status, 404);
    });

    await t.close();
    await live.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
