'use strict';
/**
 * OpenVibe.Video step C: playlists on openvibe.video. Covers sign-in on the video host, the add-to-playlist form on
 * the watch pages, the playlist pages and the playlist API (create, add vod/clip, duplicate, reorder, remove,
 * rename, visibility), private/unlisted access, limits, CSRF, account export/erasure, the ?list= up-next panel and
 * the signed-in cache rule.
 */
const assert = require('assert');
const http = require('http');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 'm'.repeat(48);
const EXPORT = 'exp_01JABCDEFGHJKMNPQRSTVWXYZ0';
const DELETION = 'del_01JABCDEFGHJKMNPQRSTVWXYZ0';

function startLive() {
    const publicVod = {
        id: 101, title: 'A public recording', description: 'A public stream', duration_seconds: 45,
        created_at: '2026-10-12T10:00:00.000Z', thumbnail_url: 'https://openvibe.media/t/101.jpg',
        playback_url: 'https://openvibe.media/v/101', visibility: 'public', username: 'streamer', display_name: 'Streamer',
    };
    const secondVod = {
        id: 104, title: 'A long recording', description: '', duration_seconds: 300,
        created_at: '2026-10-12T09:30:00.000Z', thumbnail_url: null,
        playback_url: 'https://openvibe.media/v/104', visibility: 'public', username: 'streamer', display_name: 'Streamer',
    };
    const publicClip = {
        id: 201, vod_id: 101, title: 'A clip', start_time: 5, end_time: 15, duration_seconds: 10,
        playback_url: 'https://openvibe.media/c/201', thumbnail_url: null, visibility: 'public',
        username: 'clipper', display_name: 'Clipper',
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        const json = (status, body) => {
            const text = JSON.stringify(body);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
            res.end(text);
        };
        const vodDetail = /^\/api\/vods\/(\d+)$/.exec(url.pathname);
        if (vodDetail) {
            if (vodDetail[1] === '101') return json(200, { vod: publicVod, clips: [] });
            if (vodDetail[1] === '104') return json(200, { vod: secondVod, clips: [] });
            return json(404, { error: 'not found' });
        }
        const clipDetail = /^\/api\/clips\/(\d+)$/.exec(url.pathname);
        if (clipDetail) {
            if (clipDetail[1] === '201') return json(200, { clip: publicClip });
            return json(404, { error: 'not found' });
        }
        if (url.pathname === '/api/vods') return json(200, { vods: [publicVod], hasMore: false });
        if (url.pathname === '/api/clips') return json(200, { clips: [] });
        return json(404, { error: 'not found' });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({
            url: `http://127.0.0.1:${server.address().port}`,
            close: () => new Promise((r) => server.close(r)),
        }));
    });
}

function vreq(base, path, { host = 'openvibe.video', method = 'GET', cookie, body, headers = {}, contentType } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: host, ...headers };
        if (cookie) h.cookie = cookie;
        let data;
        if (body !== undefined && body !== null) {
            data = Buffer.isBuffer(body) ? body : Buffer.from(body);
            h['content-length'] = data.length;
            if (contentType) h['content-type'] = contentType;
        }
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), json() { return JSON.parse(buf.toString('utf8')); } });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function api(base, path, { method = 'GET', cookie, json, form, same = true } = {}) {
    const opts = { method, cookie, headers: same ? { 'sec-fetch-site': 'same-origin' } : {} };
    if (json !== undefined) { opts.body = JSON.stringify(json); opts.contentType = 'application/json'; }
    if (form !== undefined) { opts.body = new URLSearchParams(form).toString(); opts.contentType = 'application/x-www-form-urlencoded'; }
    return vreq(base, path, opts);
}

const videoEnv = (live) => ({
    MEDIAHUB_VIDEO_URL: 'https://openvibe.video',
    MEDIAHUB_LIVE_URL: live.url,
    MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live',
    MEDIAHUB_CHAT_URL: live.url,
});

(async () => {
    const live = await startLive();
    const t = await boot({ env: { ...videoEnv(live), MEDIAHUB_EVENTS_SECRET: SECRET } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimCookie = t.signIn(kim);
    const samCookie = t.signIn(sam);

    const envelope = (type, payload) => ({ event_id: `evt_${Math.random().toString(16).slice(2)}`, event_type: type, source: 'network', at: new Date().toISOString(), payload });
    const deliver = (event) => {
        const body = Buffer.from(JSON.stringify({ event }));
        return vreq(t.base, '/internal/events', { host: 'openvibe.download', method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    };

    await check('sign-in on the video host uses the video callback URI', async () => {
        const r = await vreq(t.base, '/auth/login?next=/playlists');
        assert.strictEqual(r.status, 302);
        const loc = new URL(r.headers.location);
        assert.strictEqual(loc.origin + loc.pathname, `${t.network.url}/oauth/authorize`);
        assert.strictEqual(loc.searchParams.get('redirect_uri'), 'https://openvibe.video/auth/callback');
    });

    await check('the signed-out watch page offers sign-in, not the save form', async () => {
        const r = await vreq(t.base, '/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Sign in to save to a playlist'), r.text.slice(0, 400));
        assert.ok(!r.text.includes('name="kind"'), 'no add-to-playlist form for a guest');
    });

    await check('the signed-in watch page shows the add-to-playlist form', async () => {
        const r = await vreq(t.base, '/v/101', { cookie: kimCookie });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Add to playlist'), r.text.slice(0, 400));
        assert.ok(r.text.includes('name="kind"'), 'the form carries the item kind');
    });

    await check('create, add (vod and clip), duplicate refused, reorder, remove, rename, visibility', async () => {
        const created = await api(t.base, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'My list', visibility: 'public' } });
        assert.strictEqual(created.status, 201, created.text);
        const pl = created.json().playlist;
        assert.match(pl.id, /^vpl_[0-9A-HJKMNP-TV-Z]{26}$/);
        assert.strictEqual(pl.visibility, 'public');

        const addVod = await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'vod', id: 101 } });
        assert.strictEqual(addVod.status, 201, addVod.text);
        assert.strictEqual(addVod.json().item.kind, 'vod');
        assert.strictEqual(addVod.json().item.id, 101);

        const addClip = await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'clip', id: 201 } });
        assert.strictEqual(addClip.status, 201, addClip.text);
        assert.strictEqual(addClip.json().item.kind, 'clip');
        assert.strictEqual(addClip.json().item.id, 201);

        const dup = await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'vod', id: 101 } });
        assert.strictEqual(dup.status, 409, dup.text);
        assert.strictEqual(dup.json().code, 'playlist.item_duplicate');

        const reorder = await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'PATCH', cookie: kimCookie, json: { items: [{ kind: 'clip', id: 201 }, { kind: 'vod', id: 101 }] } });
        assert.strictEqual(reorder.status, 200, reorder.text);
        assert.deepStrictEqual(reorder.json().items.map((x) => [x.kind, x.id]), [['clip', 201], ['vod', 101]]);

        const remove = await api(t.base, `/api/v1/video/playlists/${pl.id}/items/vod/101`, { method: 'DELETE', cookie: kimCookie });
        assert.strictEqual(remove.status, 204, remove.text);

        const rename = await api(t.base, `/api/v1/video/playlists/${pl.id}`, { method: 'PATCH', cookie: kimCookie, json: { title: 'Renamed' } });
        assert.strictEqual(rename.status, 200, rename.text);
        assert.strictEqual(rename.json().playlist.title, 'Renamed');

        const vis = await api(t.base, `/api/v1/video/playlists/${pl.id}`, { method: 'PATCH', cookie: kimCookie, json: { visibility: 'unlisted' } });
        assert.strictEqual(vis.status, 200, vis.text);
        assert.strictEqual(vis.json().playlist.visibility, 'unlisted');
    });

    await check('a private playlist is a 404 for someone else and signed-out; unlisted is reachable but noindex', async () => {
        const priv = await api(t.base, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'Private list', visibility: 'private' } });
        const pid = priv.json().playlist.id;
        await api(t.base, `/api/v1/video/playlists/${pid}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'vod', id: 101 } });

        assert.strictEqual((await vreq(t.base, `/playlists/${pid}`, { cookie: samCookie })).status, 404, 'someone else gets a 404');
        assert.strictEqual((await vreq(t.base, `/playlists/${pid}`)).status, 404, 'a guest gets a 404');

        const unlisted = await api(t.base, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'Unlisted list', visibility: 'unlisted' } });
        const uid = unlisted.json().playlist.id;
        const u = await vreq(t.base, `/playlists/${uid}`);
        assert.strictEqual(u.status, 200);
        assert.ok(u.text.includes('<meta name="robots" content="noindex">'), 'unlisted is noindex');
        assert.ok(u.text.includes('Unlisted list'), 'the title renders');
    });

    await check('a channel page lists that person\'s public playlists only', async () => {
        const mk = async (title, visibility) => {
            const r = await api(t.base, '/playlists', { method: 'POST', cookie: kimCookie, form: { title, visibility } });
            assert.strictEqual(r.status, 303, r.text);
            return r.headers.location.split('/').pop();
        };
        const pub = await mk('Kim channel public', 'public');
        await mk('Kim channel unlisted', 'unlisted');
        await mk('Kim channel private', 'private');
        const page = await vreq(t.base, '/@kim');
        assert.strictEqual(page.status, 200, page.text.slice(0, 300));
        assert.ok(page.text.includes('id="h-lists"'), 'a Playlists section');
        assert.ok(page.text.includes(`href="/playlists/${pub}"`) && page.text.includes('Kim channel public'), 'the public playlist');
        assert.ok(!page.text.includes('Kim channel unlisted') && !page.text.includes('Kim channel private'), 'never unlisted or private');
        assert.ok(!page.text.includes('ovv-pl-edit'), 'no owner controls on a channel page');
        const other = await vreq(t.base, '/@sam');
        assert.strictEqual(other.status, 200);
        assert.ok(!other.text.includes('id="h-lists"'), 'no section without public playlists');
    });

    await check('a signed-in playlist write is refused without the same-origin signal', async () => {
        const r = await api(t.base, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'csrf' }, same: false });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'request.cross_site');
    });

    await check('?list= shows Up next and the next item link', async () => {
        const created = await api(t.base, '/api/v1/video/playlists', { method: 'POST', cookie: kimCookie, json: { title: 'Queue', visibility: 'public' } });
        const pl = created.json().playlist;
        await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'vod', id: 101 } });
        await api(t.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: kimCookie, json: { kind: 'clip', id: 201 } });

        const r = await vreq(t.base, `/v/101?list=${pl.id}`);
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('Up next in'), r.text.slice(0, 500));
        assert.ok(r.text.includes(`/c/201?list=${pl.id}`), 'the next item is linked');
        assert.ok(r.text.includes(`data-ovv-next="/c/201?list=${pl.id}"`), 'the player carries the next url');

        const noList = await vreq(t.base, '/v/101');
        assert.ok(!noList.text.includes('Up next in'), 'no up-next panel without ?list=');
    });

    await check('signed-in pages are private, no-store; signed-out pages are public', async () => {
        const signedIn = await vreq(t.base, '/v/101', { cookie: kimCookie });
        assert.strictEqual(signedIn.headers['cache-control'], 'private, no-store');
        const signedOut = await vreq(t.base, '/v/101');
        assert.strictEqual(signedOut.headers['cache-control'], 'public, max-age=0, must-revalidate', 'a guest copy is revalidated, never reused after a sign-in');
        const lists = await vreq(t.base, '/playlists', { cookie: kimCookie });
        assert.strictEqual(lists.headers['cache-control'], 'private, no-store');
    });

    await check('account export includes the person\'s playlists and items', async () => {
        const r = await deliver(envelope('network.account.export_requested', { export_id: EXPORT, subject: kim.subject }));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'exported');
        assert.strictEqual(t.network.accountParts.length, 1, 'Network was given the part');
        const part = t.network.accountParts[0].body;
        const plFile = part.files.find((f) => f.name === 'playlists.json');
        const itemFile = part.files.find((f) => f.name === 'playlist_items.json');
        assert.ok(plFile, 'a playlists.json part');
        assert.ok(plFile.content.some((p) => p.title === 'Renamed' || p.title === 'Private list' || p.title === 'Unlisted list' || p.title === 'Queue'));
        assert.ok(itemFile, 'a playlist_items.json part');
        assert.ok(itemFile.content.length >= 1);
    });

    await check('erasure removes the playlists', async () => {
        const r = await deliver(envelope('network.account.deleted', { deletion_id: DELETION, subject: kim.subject }));
        assert.strictEqual(r.status, 200, r.text);
        assert.strictEqual(r.json().outcome, 'erased');
        const list = await api(t.base, '/api/v1/video/playlists', { method: 'GET', cookie: kimCookie });
        assert.strictEqual(list.json().playlists.length, 0, 'kim has no playlists left');
    });

    await t.close();

    // Limits, lowered through the environment.
    const t2 = await boot({ env: { ...videoEnv(live), MEDIAHUB_VIDEO_PLAYLISTS_MAX: '2', MEDIAHUB_VIDEO_PLAYLIST_ITEMS_MAX: '3' } });
    const kim2 = t2.network.addUser('kim');
    const c2 = t2.signIn(kim2);

    await check('playlist and item limits are enforced', async () => {
        for (let i = 0; i < 2; i++) {
            const r = await api(t2.base, '/api/v1/video/playlists', { method: 'POST', cookie: c2, json: { title: 'p' + i } });
            assert.strictEqual(r.status, 201, r.text);
        }
        const third = await api(t2.base, '/api/v1/video/playlists', { method: 'POST', cookie: c2, json: { title: 'p3' } });
        assert.strictEqual(third.status, 422, third.text);
        assert.strictEqual(third.json().code, 'playlist.limit');

        const pl = (await api(t2.base, '/api/v1/video/playlists', { method: 'GET', cookie: c2 })).json().playlists[0];
        for (let i = 0; i < 3; i++) {
            const r = await api(t2.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: c2, json: { kind: 'vod', id: 101 + i } });
            assert.strictEqual(r.status, 201, r.text);
        }
        const fourth = await api(t2.base, `/api/v1/video/playlists/${pl.id}/items`, { method: 'POST', cookie: c2, json: { kind: 'vod', id: 999 } });
        assert.strictEqual(fourth.status, 422, fourth.text);
        assert.strictEqual(fourth.json().code, 'playlist.items_limit');
    });

    await t2.close();
    await live.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
