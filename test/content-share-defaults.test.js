'use strict';
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    const owner = t.network.addUser('owner');
    const other = t.network.addUser('other');
    const reader = t.network.addUser('reader');
    const same = { 'sec-fetch-site': 'same-origin' };
    const requester = (user) => `user:${user.subject}`;
    const share = (kind, id) => t.ctx.sharing.shareOf(kind, id);
    const hostRequest = (host, path, user, { method = 'GET', json } = {}) => new Promise((resolve, reject) => {
        const url = new URL(t.base + path);
        const body = json === undefined ? null : Buffer.from(JSON.stringify(json));
        const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname + url.search,
            method, headers: { Host: host, ...(user ? { Cookie: t.signIn(user) } : {}),
                ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Sec-Fetch-Site': 'same-origin' } : {}) } }, (res) => {
            const parts = [];
            res.on('data', (part) => parts.push(part));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString('utf8') }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
    const hostGet = (host, path, user) => hostRequest(host, path, user);
    let sequence = 0;
    const picture = async (user, audience) => {
        const n = ++sequence;
        const buffer = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: n, g: n * 7, b: 99 } } }).png().toBuffer();
        const out = await t.ctx.pics.upload({ requester: requester(user) }, { buffer, name: `${n}.png` }, { audience });
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        return out.image;
    };
    const video = async (user, audience) => await t.ctx.videoUploads.start({ requester: requester(user), username: 'owner' }, {
        title: `Video ${++sequence}`, size: 12, contentType: 'video/mp4', name: 'clip.mp4', audience,
    });
    try {
        await check('each kind saves a personal default and rejects an invalid audience', async () => {
            for (const kind of ['picture', 'album', 'video', 'download']) {
                const get = await t.get(`/api/v1/share-defaults/${kind}`, { as: owner });
                assert.strictEqual(get.status, 200, get.text);
                assert.strictEqual(get.json().audience, 'public');
            }
            assert.strictEqual((await t.get('/api/v1/share-defaults/picture', { as: other })).json().audience, 'public');
            const invalid = await t.get('/api/v1/share-defaults/picture', { as: owner, method: 'PUT', json: { audience: 'everyone-ish' }, headers: same });
            assert.strictEqual(invalid.status, 422);
            for (const [kind, audience] of [['picture', 'private'], ['album', 'people'], ['video', 'link']]) {
                const set = await t.get(`/api/v1/share-defaults/${kind}`, { as: owner, method: 'PUT', json: { audience }, headers: same });
                assert.strictEqual(set.status, 200, set.text);
                assert.strictEqual(set.json().audience, audience);
            }
            const videoHost = await hostGet('openvibe.video', '/api/v1/share-defaults/video', owner);
            assert.strictEqual(videoHost.status, 200, videoHost.text);
            assert.strictEqual(JSON.parse(videoHost.text).audience, 'link');
            const picsHost = await hostRequest('openvibe.pics', '/api/v1/share-defaults/picture', owner,
                { method: 'PUT', json: { audience: 'private' } });
            assert.strictEqual(picsHost.status, 200, picsHost.text);
        });

        let ownPic, otherPic, ownAlbum, otherAlbum, ownVideo, otherVideo;
        await check('new items use the saved choice, with a per-item override', async () => {
            ownPic = await picture(owner);
            otherPic = await picture(other);
            assert.strictEqual((await share('picture', ownPic.id)).audience, 'private');
            assert.strictEqual((await share('picture', otherPic.id)).audience, 'public');
            const overridePic = await picture(owner, 'public');
            assert.strictEqual((await share('picture', overridePic.id)).audience, 'public');
            ownAlbum = (await t.ctx.pics.createAlbum(requester(owner), { title: 'Owned album' })).album;
            otherAlbum = (await t.ctx.pics.createAlbum(requester(other), { title: 'Other album' })).album;
            assert.strictEqual((await share('album', ownAlbum.id)).audience, 'people');
            assert.strictEqual((await share('album', otherAlbum.id)).audience, 'public');
            ownVideo = await video(owner);
            otherVideo = await video(other);
            assert.strictEqual((await share('video', ownVideo.id)).audience, 'link');
            assert.strictEqual(ownVideo.visibility, 'unlisted');
            assert.strictEqual((await share('video', otherVideo.id)).audience, 'public');
            const overrideVideo = await video(owner, 'people');
            assert.strictEqual((await share('video', overrideVideo.id)).audience, 'people');
            assert.strictEqual(overrideVideo.visibility, 'private');
        });

        await check('apply to all changes only the person\'s own items and updates Media video visibility', async () => {
            for (const [kind, audience] of [['picture', 'link'], ['album', 'private'], ['video', 'private']]) {
                const set = await t.get(`/api/v1/share-defaults/${kind}`, { as: owner, method: 'PUT', json: { audience, apply: true }, headers: same });
                assert.strictEqual(set.status, 200, set.text);
                assert(set.json().changed >= 1);
            }
            assert.strictEqual((await share('picture', ownPic.id)).audience, 'link');
            assert.strictEqual((await share('picture', otherPic.id)).audience, 'public');
            assert.strictEqual((await share('album', ownAlbum.id)).audience, 'private');
            assert.strictEqual((await share('album', otherAlbum.id)).audience, 'public');
            assert.strictEqual((await share('video', ownVideo.id)).audience, 'private');
            assert.strictEqual((await share('video', otherVideo.id)).audience, 'public');
            assert.strictEqual((await t.ctx.videoUploads.byId(ownVideo.id)).visibility, 'private');
            assert.strictEqual(t.media.vods.get(Number(ownVideo.media_vod_id)).visibility, 'private');
        });

        await check('Specific people can open a ready Video watch route but a stranger cannot', async () => {
            const row = await video(owner, 'people');
            await t.ctx.sharing.addMembers({ subject: owner.subject }, 'video', row.id, [{ subject: { type: 'user', id: reader.subject }, role: 'viewer' }]);
            await t.ctx.s.db.exec("UPDATE video_uploads SET status = 'ready' WHERE id = $1", [row.id]);
            const path = `/u/${row.id}`;
            const named = await hostGet('openvibe.video', path, reader);
            const stranger = await hostGet('openvibe.video', path, other);
            assert([200, 301].includes(named.status), named.text.slice(0, 300));
            assert.strictEqual(stranger.status, 404);
            if (named.status === 301) {
                const watch = await hostGet('openvibe.video', named.headers.location, reader);
                assert.strictEqual(watch.status, 200, watch.text.slice(0, 300));
                assert(watch.text.includes(`Video ${sequence}`));
                assert(watch.text.includes(`data-kind="video" data-id="${row.id}"`), 'the watch page opens the uniform Share sheet');
                assert.strictEqual((await hostGet('openvibe.video', named.headers.location, other)).status, 404);
            }
        });

        await check('owner pages include the saved choices and apply controls', async () => {
            const pics = await hostGet('openvibe.pics', '/mine', owner);
            assert.strictEqual(pics.status, 200, pics.text.slice(0, 200));
            assert(pics.text.includes('Apply to all my existing pictures'));
            const albums = await hostGet('openvibe.pics', '/albums', owner);
            assert.strictEqual(albums.status, 200, albums.text.slice(0, 200));
            assert(albums.text.includes('Apply to all my existing albums'));
            const videos = await hostGet('openvibe.video', '/me/videos', owner);
            assert.strictEqual(videos.status, 200, videos.text.slice(0, 200));
            assert(videos.text.includes('Apply to all my existing videos'));
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
