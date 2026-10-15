'use strict';
/**
 * OpenVibe.Video uploads (server/video/uploads.js, upload-routes.js): a signed-in person uploads a video in 8 MB parts
 * from openvibe.video; it becomes a Media VOD in MediaHub's tenant (the bytes appended in order, QuickTime sent as
 * MP4), completes in the background, and gets a watch page, a place on the channel and the home page, and the sitemap.
 *   - only a signed-in, same-origin person may upload; types, sizes and the order of parts are checked;
 *   - a processing upload says so and reloads itself, then plays from Media's file and HLS;
 *   - unlisted and private ones stay off lists, private ones off the page for anyone but the owner;
 *   - the owner edits (Media's title follows) and deletes (Media's VOD is deleted);
 *   - reports: one per person, a child-safety report hides it at once; the owner still sees it, labelled.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const MB = 1024 * 1024;

function startLive() {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ vods: [], clips: [], items: [], hasMore: false }));
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function vreq(base, path, { method = 'GET', cookie, form, json, body, same = true, type } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: 'openvibe.video' };
        if (cookie) h.cookie = cookie;
        if (same && method !== 'GET') h['sec-fetch-site'] = 'same-origin';
        let data;
        if (form) { data = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; }
        if (json) { data = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
        if (body) { data = body; h['content-type'] = type || 'application/octet-stream'; }
        if (data) h['content-length'] = data.length;
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

(async () => {
    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url, VIDEO_UPLOADS_PER_DAY: '4' } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimCookie = t.signIn(kim);
    const samCookie = t.signIn(sam);
    const file = Buffer.alloc(8 * MB + 1234, 7);
    file.write('ftypqt  ', 4);
    let id = null;

    await check('signed out, cross-site, wrong type and too big are refused before Media hears of it', async () => {
        const meta = { title: 'Trip', size: file.length, content_type: 'video/quicktime', name: 'trip.mov', visibility: 'public' };
        assert.strictEqual((await vreq(t.base, '/api/v1/videos', { method: 'POST', json: meta })).status, 401);
        assert.strictEqual((await vreq(t.base, '/api/v1/videos', { method: 'POST', json: meta, cookie: kimCookie, same: false })).status, 403);
        const avi = await vreq(t.base, '/api/v1/videos', { method: 'POST', json: { ...meta, content_type: 'video/x-msvideo', name: 'trip.avi' }, cookie: kimCookie });
        assert.strictEqual(avi.status, 415);
        assert.match(avi.json().detail, /MP4, MOV, WebM or MKV/);
        assert.strictEqual((await vreq(t.base, '/api/v1/videos', { method: 'POST', json: { ...meta, size: 3 * 1024 * MB }, cookie: kimCookie })).status, 413);
        assert.strictEqual(t.media.vods.size, 0, 'no VOD was created');
    });

    await check('a MOV goes up in 8 MB parts, in order, to one Media VOD as MP4, and completes in the background', async () => {
        const start = await vreq(t.base, '/api/v1/videos', { method: 'POST', json: { title: 'Trip to the coast', description: 'Line one\nLine two', size: file.length, content_type: 'video/quicktime', name: 'trip.mov', visibility: 'public' }, cookie: kimCookie });
        assert.strictEqual(start.status, 201, start.text);
        const up = start.json().upload;
        id = up.id;
        assert.match(id, /^vup_[0-9A-Z]{26}$/);
        assert.deepStrictEqual([up.part_size, up.parts_expected], [8 * MB, 2]);
        const out = await vreq(t.base, `/api/v1/videos/${id}/parts/2`, { method: 'PUT', body: file.subarray(8 * MB), cookie: kimCookie });
        assert.strictEqual(out.status, 409, 'part 1 first');
        assert.strictEqual((await vreq(t.base, `/api/v1/videos/${id}/parts/1`, { method: 'PUT', body: file.subarray(0, 100), cookie: kimCookie })).status, 422, 'a part is its full size');
        assert.strictEqual((await vreq(t.base, `/api/v1/videos/${id}/parts/1`, { method: 'PUT', body: file.subarray(0, 8 * MB), cookie: samCookie })).status, 404, 'not sam\'s upload');
        assert.strictEqual((await vreq(t.base, `/api/v1/videos/${id}/parts/1`, { method: 'PUT', body: file.subarray(0, 8 * MB), cookie: kimCookie })).status, 200);
        assert.strictEqual((await vreq(t.base, `/api/v1/videos/${id}/parts/2`, { method: 'PUT', body: file.subarray(8 * MB), cookie: kimCookie })).status, 200);
        const vod = [...t.media.vods.values()][0];
        assert.ok(vod.bytes.equals(file), 'Media has the file, byte for byte');
        assert.deepStrictEqual(vod.types, ['video/mp4', 'video/mp4'], 'QuickTime is sent as MP4');
        assert.strictEqual(vod.user_id, kim.subject);
        const done1 = await vreq(t.base, `/api/v1/videos/${id}/complete`, { method: 'POST', cookie: kimCookie });
        assert.strictEqual(done1.status, 202);
        assert.strictEqual(done1.json().video.url, `/u/${id}`);
    });

    await check('the watch page plays it from Media, and it is on the channel, the home page and the sitemap', async () => {
        let page = null;
        for (let i = 0; i < 20; i++) {
            page = await vreq(t.base, `/u/${id}`);
            if (page.status === 200 && page.text.includes('data-ovv-video')) break;
            await new Promise((r) => setTimeout(r, 50));
        }
        assert.strictEqual(page.status, 200, page.text.slice(0, 200));
        assert.ok(page.text.includes('<h1 class="ovv-title">Trip to the coast</h1>'));
        assert.ok(page.text.includes('src="https://openvibe.media/v/vod-1.mp4"') && page.text.includes('data-ovv-hls="https://openvibe.media/o/med_vod1/master.m3u8"'), 'the file, and HLS on the same origin');
        assert.ok(page.text.includes('Line one\nLine two'));
        assert.ok(page.text.includes('<a class="ovv-channel-name" href="/@kim">@kim</a>'));
        assert.ok(page.text.includes('Report this video'), 'others may report it');
        assert.ok(!page.text.includes('Manage this video'));
        assert.ok((await vreq(t.base, '/')).text.includes(`href="/u/${id}"`), 'the home page');
        assert.ok((await vreq(t.base, '/@kim')).text.includes(`href="/u/${id}"`), 'the channel');
        assert.ok((await vreq(t.base, '/sitemap.xml')).text.includes(`https://openvibe.video/u/${id}`), 'the sitemap');
        const mine = await vreq(t.base, '/me/videos', { cookie: kimCookie });
        assert.ok(mine.text.includes('Trip to the coast') && mine.text.includes('Public'));
    });

    await check('the owner edits (Media follows) and makes it private: gone for everyone else, still the owner\'s', async () => {
        const r = await vreq(t.base, `/u/${id}/manage`, { method: 'POST', cookie: kimCookie, form: { title: 'Coast trip', description: 'x', visibility: 'private' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual([...t.media.vods.values()][0].title, 'Coast trip');
        assert.strictEqual((await vreq(t.base, `/u/${id}`)).status, 404);
        assert.strictEqual((await vreq(t.base, `/u/${id}`, { cookie: samCookie })).status, 404);
        const own = await vreq(t.base, `/u/${id}`, { cookie: kimCookie });
        assert.ok(own.text.includes('Private: only you') && own.text.includes('noindex'));
        assert.ok(!(await vreq(t.base, '/')).text.includes(`/u/${id}`), 'off the home page');
        assert.strictEqual((await vreq(t.base, `/u/${id}/manage`, { method: 'POST', cookie: samCookie, form: { title: 'Mine now' } })).status, 404);
        await vreq(t.base, `/u/${id}/manage`, { method: 'POST', cookie: kimCookie, form: { title: 'Coast trip', visibility: 'public' } });
    });

    await check('a child-safety report hides it at once; one report per person; the owner sees why', async () => {
        const r = await vreq(t.base, `/u/${id}/report`, { method: 'POST', cookie: samCookie, form: { reason: 'child_safety', note: 'look at 0:12' } });
        assert.strictEqual(r.status, 303);
        assert.strictEqual((await vreq(t.base, `/u/${id}`)).status, 404, 'hidden from everyone');
        const own = await vreq(t.base, `/u/${id}`, { cookie: kimCookie });
        assert.ok(own.text.includes('Hidden after reports'));
        assert.strictEqual((await vreq(t.base, `/u/${id}/report`, { method: 'POST', cookie: samCookie, form: { reason: 'nonsense' } })).status, 404, 'hidden: not reportable by others');
    });

    await check('delete removes the VOD in Media; the daily limit holds', async () => {
        const r = await vreq(t.base, `/u/${id}/delete`, { method: 'POST', cookie: kimCookie, form: { confirm: '1' } });
        assert.strictEqual(r.status, 303);
        assert.deepStrictEqual(t.media.deletedVods, [1]);
        assert.strictEqual((await vreq(t.base, `/u/${id}`, { cookie: kimCookie })).status, 404);
        const meta = { title: 'More', size: 10, content_type: 'video/mp4', name: 'a.mp4' };
        for (let i = 0; i < 3; i++) assert.strictEqual((await vreq(t.base, '/api/v1/videos', { method: 'POST', json: meta, cookie: kimCookie })).status, 201);
        const fifth = await vreq(t.base, '/api/v1/videos', { method: 'POST', json: meta, cookie: kimCookie });
        assert.strictEqual(fifth.status, 429);
    });

    await t.close();
    await live.close();
    done();
})();
