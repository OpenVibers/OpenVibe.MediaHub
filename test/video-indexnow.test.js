'use strict';
/**
 * openvibe.video's IndexNow (server/video/indexnow.js): the first sweep only remembers Live's feed; a later sweep
 * pings each new watch page with its channel page and the sitemap, once; a feed Live cannot serve pings and
 * remembers nothing; without a key nothing is read. The key file answers on the video host only, and only with a key.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createVideoIndexNow } = require('../server/video/indexnow');

const config = { video: { url: 'https://openvibe.video' } };
const item = (kind, id, username) => ({ kind, id, title: `${kind} ${id}`, channel: { username } });

function fakeLive(feeds) {
    const live = { calls: 0, down: false };
    live.feed = async ({ type }) => {
        live.calls++;
        if (live.down) throw new Error('Live did not answer');
        return { items: feeds[type].slice(), next: null };
    };
    return live;
}
function fakeIndexNow(enabled = true) {
    const pinged = [];
    return { enabled, pinged, pingSoon: (urls) => { pinged.push(...urls); return urls.length; } };
}
const quiet = { warn() {}, log() {} };

function request(base, path, host) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Host: host } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    await check('the first sweep remembers what is there; a later one pings each new page, its channel and the sitemap, once', async () => {
        const feeds = { vods: [item('vod', 101, 'streamer')], clips: [item('clip', 201, 'clipper')] };
        const live = fakeLive(feeds);
        const indexnow = fakeIndexNow();
        const v = createVideoIndexNow({ config, live, indexnow, log: quiet });
        assert.deepStrictEqual(await v.sweep(), { pinged: 0 });
        assert.deepStrictEqual(indexnow.pinged, [], 'what was already there is not announced');

        feeds.vods.unshift(item('vod', 102, 'streamer'));
        feeds.clips.unshift(item('clip', 202, 'bad name!'));
        assert.deepStrictEqual(await v.sweep(), { pinged: 2 });
        assert.deepStrictEqual(indexnow.pinged, [
            'https://openvibe.video/v/102', 'https://openvibe.video/@streamer',
            'https://openvibe.video/c/202',
            'https://openvibe.video/sitemap.xml',
        ], 'a channel name that is not a username is left out');

        indexnow.pinged.length = 0;
        assert.deepStrictEqual(await v.sweep(), { pinged: 0 });
        assert.deepStrictEqual(indexnow.pinged, [], 'a page is announced once');
    });

    await check('a feed Live cannot serve pings nothing and primes nothing', async () => {
        const feeds = { vods: [item('vod', 101, 'streamer')], clips: [] };
        const live = fakeLive(feeds);
        const indexnow = fakeIndexNow();
        const v = createVideoIndexNow({ config, live, indexnow, log: quiet });
        live.down = true;
        assert.deepStrictEqual(await v.sweep(), { pinged: 0, skipped: 'feed' });
        live.down = false;
        assert.deepStrictEqual(await v.sweep(), { pinged: 0 }, 'the first good read only remembers');
        assert.deepStrictEqual(indexnow.pinged, []);
    });

    await check('without a key nothing is read and nothing starts', async () => {
        const live = fakeLive({ vods: [], clips: [] });
        const v = createVideoIndexNow({ config, live, indexnow: fakeIndexNow(false), log: quiet });
        assert.deepStrictEqual(await v.sweep(), { pinged: 0 });
        assert.strictEqual(v.start(), false);
        assert.strictEqual(live.calls, 0);
    });

    await check('the memory stays bounded', async () => {
        const feeds = { vods: [], clips: [] };
        for (let i = 1; i <= 30; i++) feeds.vods.push(item('vod', i, 'streamer'));
        const indexnow = fakeIndexNow();
        const v = createVideoIndexNow({ config, live: fakeLive(feeds), indexnow, log: quiet, maxRemembered: 10 });
        await v.sweep();
        feeds.vods = [item('vod', 31, 'streamer')];
        assert.deepStrictEqual(await v.sweep(), { pinged: 1 });
    });

    // The key file, served by the app on the video host only (a computed stand-in key).
    const key = ['video', 'index', 'now'].join('') + '2468';
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', INDEXNOW_KEY: key } });
    try {
        await check('with a key, /<key>.txt on openvibe.video answers the key as text/plain', async () => {
            const r = await request(t.base, `/${key}.txt`, 'openvibe.video');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers['content-type'], /^text\/plain/);
            assert.strictEqual(r.text, key);
            const d = await request(t.base, `/${key}.txt`, 'openvibe.download');
            assert.notStrictEqual(d.text, key, 'the drive host does not serve the video host\'s key');
        });
    } finally { await t.close(); }
    const off = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    try {
        await check('without a key there is no key file', async () => {
            const r = await request(off.base, `/${key}.txt`, 'openvibe.video');
            assert.strictEqual(r.status, 404);
        });
    } finally { await off.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
