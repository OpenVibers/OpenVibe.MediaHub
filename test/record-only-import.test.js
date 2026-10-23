'use strict';
/**
 * Record only, to my videos (plan 2026-10-22 §3 D1): OpenRestream records a record-only stream into this tenant as a
 * private Media VOD whose meta names the owner; when Media says it is ready (media.vod.ready, signed on
 * POST /internal/events) it becomes that person's private video here (server/video/uploads.js importRecording).
 *   - only a VOD of this tenant marked record-only by OpenRestream, with an owner subject, is filed; anything else,
 *     and anything not from Media, is acknowledged and left alone;
 *   - it is private and ready, plays for its owner only, and a redelivery files nothing twice;
 *   - its owner's channel name is filled in when they first open their videos;
 *   - MediaHub subscribes to media.vod.ready beside the account topics.
 */
const assert = require('assert');
const http = require('http');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');

const SECRET = 'r'.repeat(48);

function vget(base, path, cookie) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'openvibe.video', ...(cookie ? { cookie } : {}) } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const t = await boot({ env: { MEDIAHUB_EVENTS_SECRET: SECRET, MEDIAHUB_VIDEO_URL: 'https://openvibe.video' } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const db = t.ctx.s.db;

    // The VOD OpenRestream asked Media for (server/store/recordings.js vodFields), finished.
    const meta = { source: 'openre', openre_session_id: 'ses_01JABCDEFGHJKMNPQRSTVWXYZ0', openre_stream_id: 'str_01JABCDEFGHJKMNPQRSTVWXYZ0', protocol: 'rtmp', mode: 'vod', record_only: true, owner_subject: kim.subject };
    t.media.vods.set(900, { id: 900, title: 'Morning take', visibility: 'private', user_id: null, meta, bytes: Buffer.alloc(4096, 1), types: [], status: 'ready' });
    const ready = (over = {}) => ({
        id: 900, app_id: 'media-hub', title: 'Morning take', user_id: null, visibility: 'private', is_recording: false,
        duration_seconds: 42.5, file_size: 4096, file_url: 'https://openvibe.media/v/vod-900.mp4', thumbnail_url: 'https://openvibe.media/t/vod-900.jpg', meta, ...over,
    });
    const deliver = (payload, { source = 'media', type = 'media.vod.ready' } = {}) => {
        const event = { event_id: `evt_${Math.random().toString(16).slice(2)}`, event_type: type, source, at: new Date().toISOString(), payload };
        const body = Buffer.from(JSON.stringify({ event }));
        return t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    };
    const rows = () => db.many('SELECT * FROM video_uploads ORDER BY created_at');

    await check('a ready record-only VOD of this tenant becomes its owner\'s private, ready video', async () => {
        const r = await deliver(ready());
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.strictEqual(r.json().outcome, 'filed');
        const [row] = await rows();
        assert.deepStrictEqual([row.owner, row.visibility, row.status, Number(row.media_vod_id), row.title, Number(row.size_bytes), row.owner_username],
            [`user:${kim.subject}`, 'private', 'ready', 900, 'Morning take', 4096, null]);
        assert.strictEqual(Number(row.duration_seconds), 42.5);
    });

    await check('a redelivery files nothing twice', async () => {
        assert.strictEqual((await deliver(ready())).json().outcome, 'filed');
        assert.strictEqual((await rows()).length, 1);
    });

    await check('any other VOD, or one not from Media, is acknowledged and left alone', async () => {
        const live = await deliver(ready({ id: 901, app_id: 'live', meta: { source: 'openre', mode: 'vod' } }));
        assert.deepStrictEqual([live.status, live.json().outcome], [200, 'ignored:not_record_only']);
        assert.strictEqual((await deliver(ready({ id: 902, meta: { ...meta, record_only: false } }))).json().outcome, 'ignored:not_record_only');
        assert.strictEqual((await deliver(ready({ id: 903, meta: { source: 'media-hub', record_only: true, owner_subject: kim.subject } }))).json().outcome, 'ignored:not_record_only');
        assert.strictEqual((await deliver(ready({ id: 904, meta: { ...meta, owner_subject: 'kim' } }))).json().outcome, 'ignored:not_record_only');
        assert.strictEqual((await deliver(ready({ id: 905 }), { source: 'network' })).json().outcome, 'ignored:source');
        assert.strictEqual((await rows()).length, 1);
    });

    await check('it plays for its owner only, and their channel name is filled in when they open their videos', async () => {
        const [row] = await rows();
        assert.strictEqual((await vget(t.base, `/u/${row.id}`)).status, 404, 'private: not for the signed-out');
        assert.strictEqual((await vget(t.base, `/u/${row.id}`, t.signIn(sam))).status, 404, 'nor for anyone else');
        const page = await vget(t.base, `/u/${row.id}`, t.signIn(kim));
        assert.strictEqual(page.status, 200);
        assert.match(page.text, /Morning take/);
        const mine = await vget(t.base, '/me/videos', t.signIn(kim));
        assert.match(mine.text, new RegExp(`/u/${row.id}`));
        assert.strictEqual((await db.maybe('SELECT owner_username FROM video_uploads WHERE id = $1', [row.id])).owner_username, 'kim');
    });

    await check('MediaHub subscribes to media.vod.ready beside the account topics', async () => {
        const { TOPICS } = require('../server/events-consumer');
        assert.ok(TOPICS.includes('media.vod.ready'));
        assert.ok(TOPICS.includes('network.account.deleted'));
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
