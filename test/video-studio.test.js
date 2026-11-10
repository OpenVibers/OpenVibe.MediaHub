'use strict';
/**
 * Studio's "Edit in Studio" hand-off on OpenVibe.Video (server/video/studio.js):
 * - a person opens metadata and bytes with their own Network token as a Bearer;
 * - a private video of someone else answers exactly like a missing id (404), with no title leak;
 * - a public video can be read but only its owner can publish it;
 * - publishing makes a new private copy on Video (the original is unchanged);
 * - the owner's watch page and Your videos link to Studio with the video's id.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

const VIDEO = 'https://openvibe.video';

function areq(base, path, { method = 'GET', bearer, json, range, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const headers = { Host: new URL(VIDEO).host };
        if (method !== 'GET') headers['sec-fetch-site'] = 'same-origin';
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        if (cookie) headers.cookie = cookie;
        if (range) headers.range = range;
        let body;
        if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

(async () => {
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: VIDEO, MEDIAHUB_LIVE_URL: 'http://127.0.0.1:1', MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: 'http://127.0.0.1:1', MEDIAHUB_STUDIO_URL: 'https://openvibe.studio', MEDIAHUB_STUDIO_VIDEO_EDIT: '1' } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimToken = t.network.userToken(kim);
    const samToken = t.network.userToken(sam);
    const body = Buffer.from('a finished recording, byte for byte');

    /** A ready row of kim's, with the bytes in Media's stand-in. */
    async function ready({ visibility, title, id }) {
        const row = await t.ctx.videoUploads.startRecording({ requester: `user:${kim.subject}`, username: 'kim' }, { title, contentType: 'video/webm', visibility });
        const vod = t.media.vods.get(Number(row.media_vod_id));
        vod.bytes = Buffer.from(body);
        vod.status = 'ready';
        await t.ctx.s.db.query("UPDATE video_uploads SET status = 'ready', duration_seconds = 12, size_bytes = $2, thumbnail_url = 'https://openvibe.media/t/x.jpg' WHERE id = $1", [row.id, body.length]);
        return await t.ctx.videoUploads.byId(row.id);
    }

    const priv = await ready({ visibility: 'private', title: 'Private rehearsal' });
    const pub = await ready({ visibility: 'public', title: 'Public talk' });

    await check('a person reads their own private video with their own token', async () => {
        const r = await areq(t.base, `/api/v1/video/studio/media/${priv.id}`, { bearer: kimToken });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        const out = r.json();
        assert.strictEqual(out.media.id, priv.id);
        assert.strictEqual(out.media.can_edit, true);
        assert.strictEqual(out.source.id, 'video');
        assert.strictEqual(out.source.name, 'OpenVibe.Video');
        assert.strictEqual(out.media.watch_url, `${VIDEO}/watch?v=${priv.watch_id}`);
    });

    await check('someone else guessing a private id gets 404, never the title', async () => {
        const r = await areq(t.base, `/api/v1/video/studio/media/${priv.id}`, { bearer: samToken });
        assert.strictEqual(r.status, 404);
        assert.ok(!r.text.includes('Private rehearsal'), 'the title does not leak');
        assert.strictEqual((await areq(t.base, `/api/v1/video/studio/media/${priv.id}`)).status, 401);
        const bytes = await areq(t.base, `/api/v1/video/studio/media/${priv.id}/bytes`, { bearer: samToken });
        assert.strictEqual(bytes.status, 404);
    });

    await check('a public video is readable by anyone signed in, but only its owner may publish it', async () => {
        const r = await areq(t.base, `/api/v1/video/studio/media/${pub.id}`, { bearer: samToken });
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.strictEqual(r.json().media.can_edit, false);
        const publish = await areq(t.base, '/api/v1/video/studio/publish', { method: 'POST', bearer: samToken, json: { media: pub.id } });
        assert.strictEqual(publish.status, 404);
    });

    await check('the bytes come through with Range reads, and only when the person may read them', async () => {
        const r = await areq(t.base, `/api/v1/video/studio/media/${priv.id}/bytes`, { bearer: kimToken, range: 'bytes=2-9' });
        assert.strictEqual(r.status, 206, r.text.slice(0, 200));
        assert.strictEqual(r.headers['content-range'], `bytes 2-9/${body.length}`);
        assert.strictEqual(r.text, body.subarray(2, 10).toString('utf8'));
        assert.strictEqual((await areq(t.base, `/api/v1/video/studio/media/${priv.id}/bytes`)).status, 401);
    });

    await check('publishing makes a new private copy on Video; the original is unchanged', async () => {
        const before = await t.ctx.s.db.value('SELECT count(*)::int FROM video_uploads');
        const r = await areq(t.base, '/api/v1/video/studio/publish', { method: 'POST', bearer: kimToken, json: { media: priv.id, title: 'Rehearsal, from Studio', visibility: 'private' } });
        assert.strictEqual(r.status, 202, r.text.slice(0, 400));
        const out = r.json();
        assert.match(out.video.id, /^vup_[0-9A-Z]{26}$/);
        assert.strictEqual(out.video.title, 'Rehearsal, from Studio');
        assert.ok(out.video.watch_url.startsWith(`${VIDEO}/watch?v=`) || out.video.watch_url.startsWith(`${VIDEO}/u/`), out.video.watch_url);
        const after = await t.ctx.s.db.many('SELECT * FROM video_uploads ORDER BY created_at');
        assert.strictEqual(after.length, before + 1);
        const copy = after.find((x) => x.id === out.video.id);
        assert.strictEqual(copy.owner, `user:${kim.subject}`);
        assert.strictEqual(copy.visibility, 'private');
        assert.strictEqual(copy.edited_from, priv.id);
        assert.strictEqual((await t.ctx.videoUploads.byId(priv.id)).title, 'Private rehearsal', 'the original is unchanged');
    });

    await check('a cookie from this site cannot call the Studio hand-off; it is Bearer only', async () => {
        const r = await areq(t.base, '/api/v1/video/studio/publish', { method: 'POST', cookie: t.signIn(kim), json: { media: priv.id } });
        assert.strictEqual(r.status, 403);
        assert.match(r.json().code, /bearer/);
    });

    await check('Your videos and the finished recording have the Edit in Studio link; a stranger\'s page does not', async () => {
        const mine = await areq(t.base, '/me/videos', { cookie: t.signIn(kim) });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.text.includes(`https://openvibe.studio/edit?media=${priv.id}&amp;from=video`) || mine.text.includes(`https://openvibe.studio/edit?media=${priv.id}&from=video`), 'the row links to Studio');
        const watch = await areq(t.base, `/watch?v=${priv.watch_id}`, { cookie: t.signIn(kim) });
        assert.strictEqual(watch.status, 200);
        assert.ok(watch.text.includes(`https://openvibe.studio/edit?media=${priv.id}&amp;from=video`) || watch.text.includes(`https://openvibe.studio/edit?media=${priv.id}&from=video`), 'the finished recording links to Studio');
        const complete = await areq(t.base, `/api/v1/videos/${priv.id}/complete`, { method: 'POST', cookie: t.signIn(kim) });
        assert.strictEqual(complete.status, 202, complete.text);
        assert.strictEqual(complete.json().video.edit_url, `https://openvibe.studio/edit?media=${priv.id}&from=video`, 'the record completion names Studio when the editor is on');
        const other = await areq(t.base, `/watch?v=${pub.watch_id}`, { cookie: t.signIn(sam) });
        assert.strictEqual(other.status, 200);
        assert.ok(!other.text.includes('Edit in Studio'), 'only the owner gets the action');
    });

    await t.close();

    // The default: the hand-off API stays, but no page offers an Edit action until the editor is real.
    const off = await boot({ env: { MEDIAHUB_VIDEO_URL: VIDEO, MEDIAHUB_LIVE_URL: 'http://127.0.0.1:1', MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: 'http://127.0.0.1:1', MEDIAHUB_STUDIO_URL: 'https://openvibe.studio' } });
    try {
        const kim2 = off.network.addUser('kim');
        const row = await off.ctx.videoUploads.startRecording({ requester: `user:${kim2.subject}`, username: 'kim' }, { title: 'Default off', contentType: 'video/webm', visibility: 'public' });
        await off.ctx.s.db.query("UPDATE video_uploads SET status = 'ready', duration_seconds = 2 WHERE id = $1", [row.id]);
        const page = await areq(off.base, `/watch?v=${row.watch_id}`, { cookie: off.signIn(kim2) });
        assert.strictEqual(page.status, 200);
        assert.ok(!page.text.includes('Edit in Studio'), 'no Edit action by default');
        const mine = await areq(off.base, '/me/videos', { cookie: off.signIn(kim2) });
        assert.ok(!mine.text.includes('Edit in Studio'), 'no link on Your videos by default');
        const complete = await areq(off.base, `/api/v1/videos/${row.id}/complete`, { method: 'POST', cookie: off.signIn(kim2) });
        assert.strictEqual(complete.status, 202);
        assert.ok(!('edit_url' in complete.json().video), 'the record completion omits the link by default');
        const api = await areq(off.base, `/api/v1/video/studio/media/${row.id}`, { bearer: off.network.userToken(kim2) });
        assert.strictEqual(api.status, 200, 'the hand-off API stays available');
    } finally { await off.close(); }

    done();
})().catch((err) => { console.error(err); process.exit(1); });
