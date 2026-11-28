'use strict';
/**
 * An upload's watch page is the recording's (the owner's phone, 11-18: "Unlisted or public?", "so much crap",
 * "can't edit", "not sleek like YouTube", "more from this user … sections that help SEO and discovery", "transcripts and
 * AI overview and chapters … should apply to all videos"): who can see it and Edit under the title for the owner; one row
 * of actions; the channel with how many videos and Follow; chapters with short names and the transcript in lines beside
 * the player; More from the channel and related videos down the side; the analyser's measurements never shown as the
 * summary, and asked for again.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function vreq(base, path, { method = 'GET', cookie, json, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: 'openvibe.video' };
        if (cookie) h.cookie = cookie;
        if (method !== 'GET') h['sec-fetch-site'] = 'same-origin';
        let data;
        if (json) { data = Buffer.from(JSON.stringify(json)); h['content-type'] = 'application/json'; }
        if (body) { data = body; h['content-type'] = 'application/octet-stream'; }
        if (data) h['content-length'] = data.length;
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode === 301 && method === 'GET' && res.headers.location) { vreq(base, res.headers.location, { cookie }).then(resolve, reject); return; }
                const text = Buffer.concat(chunks).toString('utf8');
                resolve({ status: res.statusCode, text, json: () => JSON.parse(text) });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}
const stub = () => new Promise((resolve) => { const s = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ vods: [], clips: [], items: [], hasMore: false })); }); s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise((ok) => s.close(ok)) })); });
const FACTS = 'Length analysed: 2:13. Streams: video and audio. Scenes: 12. Silence: 0% of the time. Programme loudness -17.9 LUFS.';
const VERSE = 'Got some ashwagandha. Got me some magnesium. Got me some daba. Got me a water. That is my morning routine. Are you going to join me today?';

(async () => {
    const live = await stub();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const kimCookie = t.signIn(kim);
    const samCookie = t.signIn(sam);
    const make = async (cookie, title, visibility) => {
        const start = await vreq(t.base, '/api/v1/videos', { method: 'POST', cookie, json: { title, size: 10, content_type: 'video/mp4', name: 'v.mp4', visibility } });
        const id = start.json().upload.id;
        await vreq(t.base, `/api/v1/videos/${id}/parts/1`, { method: 'PUT', body: Buffer.alloc(10, 1), cookie });
        await vreq(t.base, `/api/v1/videos/${id}/complete`, { method: 'POST', cookie });
        return id;
    };
    const main = await make(kimCookie, 'Morning Routine', 'unlisted');
    const kimOther = await make(kimCookie, 'Cat on the stairs', 'public');
    const kimPrivate = await make(kimCookie, 'Private diary', 'private');
    const samMorning = await make(samCookie, 'My morning stretch', 'public');
    const db = t.ctx.s.db;
    for (let i = 0; i < 60; i++) { const n = await db.maybe("SELECT count(*)::int AS n FROM video_uploads WHERE status <> 'ready'"); if (!n || !n.n) break; await new Promise((r) => setTimeout(r, 50)); }
    await db.query(`INSERT INTO video_upload_ai (upload_id, status, attempts, overview, chapters, segments, highlights, language, updated_at) VALUES ($1, 'done', 1, $2, $3, $4, '[]', 'en', $5)
                    ON CONFLICT (upload_id) DO UPDATE SET status = 'done', attempts = 1, overview = $2, chapters = $3, segments = $4, updated_at = $5`,
    [main, FACTS, JSON.stringify([{ start: 0, title: 'Highlight' }, { start: 30, title: 'Got some ashwagandha. Got me some magnesium. Got me some daba. Got me' }, { start: 75, title: 'Got some ashwagandha. Got me some magnesium.' }]),
        JSON.stringify([{ start: 0, end: 133, text: VERSE }]), '2026-01-01T00:00:00.000Z']);
    const watchOf = async (id) => (await db.maybe('SELECT watch_id FROM video_uploads WHERE id = $1', [id])).watch_id;
    const path = `/watch?v=${await watchOf(main)}`;

    await check('the owner: who can see it and Edit under the title, the edit panel with the three choices, Delete', async () => {
        const page = await vreq(t.base, path, { cookie: kimCookie });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('<span class="ovv-kind">Upload</span>'), 'it says it is an upload');
        assert.ok(/class="ovv-ownerbar"[\s\S]*?Your video[\s\S]*?ovv-vis-badge--unlisted[\s\S]*?data-ovv-open="manage"/.test(page.text), 'Your video · Unlisted · Edit');
        assert.ok(page.text.includes(`action="/u/${main}/delete"`), 'Delete');
        assert.ok(/<details class="ovv-panel ovv-owner" id="manage"/.test(page.text) && /name="visibility" value="unlisted" checked/.test(page.text), 'Edit opens the panel, the current choice picked');
        assert.ok(!page.text.includes('class="ovv-btn ovv-follow"'), 'no Follow on your own video');
    });

    await check('a guest: one row of actions, the channel with its videos and Follow; no owner tools', async () => {
        const page = await vreq(t.base, path, { cookie: samCookie });
        assert.strictEqual(page.status, 200, 'unlisted: anyone with the link');
        assert.ok(!page.text.includes('class="ovv-ownerbar') && !page.text.includes('id="manage"'), 'no owner tools');
        assert.ok(/class="ovv-actions"[\s\S]*?Share[\s\S]*?ovv-more-menu/.test(page.text), 'Share and More in the row');
        assert.ok(/Watch together|Ask your agent/.test(page.text), 'in More');
        assert.ok(/@kim<\/a><span class="ovv-meta">1 video<span data-ovv-followers="kim" hidden><\/span><\/span>/.test(page.text), 'how many public videos the channel has, the followers filled in by the script');
        assert.ok(page.text.includes('href="https://openvibe.live/@kim"') && page.text.includes('ovv-follow'), 'Follow');
        // 11-28 (axe on Run's check): a plain link carries no aria-pressed; the script makes it a toggle button.
        assert.ok(/<a class="ovv-btn ovv-follow"[^>]*>/.test(page.text) && !/<a class="ovv-btn ovv-follow"[^>]*aria-pressed/.test(page.text), 'Follow is a link with no aria-pressed until the script makes it a button');
        assert.ok(!/<[^>]+\son[a-z]+="/i.test(page.text.split('<body')[1] || ''), 'no inline handlers (the CSP refuses them: script-src-attr none)');
    });

    await check('chapters have short names; one long segment is read as lines; the measurements are never the summary', async () => {
        const page = await vreq(t.base, path, { cookie: samCookie });
        assert.ok(/<span class="ovv-time">0:30<\/span>[\s\S]*?Got some ashwagandha</.test(page.text) && page.text.includes('Got some ashwagandha (2)'), 'short, numbered when repeated');
        assert.ok(!page.text.includes('Got me some daba. Got me</'), 'never the whole verse');
        const lines = (page.text.match(/class="ovv-line"/g) || []).length;
        assert.ok(lines >= 3, `the transcript in lines (${lines})`);
        assert.ok(!page.text.includes('Length analysed') && !page.text.includes('LUFS'), 'no measurements as the summary');
        assert.ok(page.text.includes('“Got some ashwagandha.'), 'with no description, the box quotes its opening words');
    });

    await check('down the side: More from the channel (public only) and related videos (shared words, someone else\'s)', async () => {
        const page = await vreq(t.base, path, { cookie: samCookie });
        const more = /<section class="ovv-panel ovv-also" aria-labelledby="h-more">([\s\S]*?)<\/section>/.exec(page.text);
        assert.ok(more && more[1].includes('More from @kim') && more[1].includes(`/watch?v=${await watchOf(kimOther)}`), 'the channel\'s other video');
        assert.ok(!page.text.includes(await watchOf(kimPrivate)), 'never a private one');
        const rel = /<section class="ovv-panel ovv-also" aria-labelledby="h-related">([\s\S]*?)<\/section>/.exec(page.text);
        assert.ok(rel && rel[1].includes(`/watch?v=${await watchOf(samMorning)}`), 'a public video whose title shares "morning"');
    });

    await check('a viewer likes an upload and takes it back; a private one is nobody else\'s to like', async () => {
        const seqOf = async (id) => String((await db.maybe('SELECT seq FROM video_uploads WHERE id = $1', [id])).seq);
        const like = (cookie, id) => new Promise((resolve, reject) => {
            const u = new URL(t.base + '/watch/like');
            const body = Buffer.from(new URLSearchParams({ kind: 'upload', id }).toString());
            const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'openvibe.video', cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', 'content-length': body.length } }, (res) => {
                const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
            });
            req.on('error', reject); req.write(body); req.end();
        });
        const seq = await seqOf(main);
        const page = await vreq(t.base, path, { cookie: samCookie });
        assert.ok(page.text.includes(`data-ovv-like="upload:${seq}"`) && page.text.includes('aria-pressed="false"'), 'the Like button, not pressed');
        const on = await like(samCookie, seq);
        assert.strictEqual(on.status, 200, on.text);
        assert.deepStrictEqual(JSON.parse(on.text), { count: 1, liked: true });
        assert.deepStrictEqual(JSON.parse((await like(samCookie, seq)).text), { count: 0, liked: false }, 'a second press takes it back');
        assert.strictEqual((await like(samCookie, await seqOf(kimPrivate))).status, 404, 'a private upload is not someone else\'s to like');
        assert.strictEqual((await like(kimCookie, await seqOf(kimPrivate))).status, 200, 'its owner may');
    });

    await check('Follow: the button carries the channel; a viewer follows and unfollows through Network; a guest sees the count', async () => {
        const page = await vreq(t.base, path, { cookie: samCookie });
        assert.ok(page.text.includes('data-ovv-follow="kim"') && page.text.includes('data-ovv-followers="kim"'), 'the button and the count\'s place');
        const form = (cookie, body) => new Promise((resolve, reject) => {
            const u = new URL(t.base + '/watch/follow');
            const data = Buffer.from(new URLSearchParams(body).toString());
            const rq = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { Host: 'openvibe.video', cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', 'content-length': data.length } }, (res) => {
                const c = []; res.on('data', (x) => c.push(x)); res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(c).toString('utf8')) }));
            });
            rq.on('error', reject); rq.write(data); rq.end();
        });
        const on = await form(samCookie, { channel: 'kim', follow: '1' });
        assert.strictEqual(on.status, 200);
        assert.deepStrictEqual(on.json(), { followers: 1, following: true });
        const state = await vreq(t.base, '/watch/follow?channel=kim', { cookie: samCookie });
        assert.deepStrictEqual(state.json(), { followers: 1, following: true }, 'the viewer\'s own state');
        assert.deepStrictEqual((await vreq(t.base, '/watch/follow?channel=kim')).json(), { followers: 1, following: false }, 'a guest: the count');
        assert.deepStrictEqual((await form(samCookie, { channel: 'kim', follow: '0' })).json(), { followers: 0, following: false }, 'unfollowed');
        assert.strictEqual((await form('', { channel: 'kim' })).status, 401, 'a guest signs in first');
        assert.strictEqual((await form(samCookie, { channel: 'not a name' })).status, 400);
    });

    await check('the measurements are asked again: 30 minutes after, then later each time; captions and chapters stay meanwhile', async () => {
        const { requeueSummaries } = require('../server/video/ai-edit');
        const at = (ms) => new Date(Date.now() - ms).toISOString();
        await db.query("UPDATE video_upload_ai SET status = 'done', attempts = 1, updated_at = $1 WHERE upload_id = $2", [at(10 * 60e3), main]);
        assert.strictEqual(await requeueSummaries(t.ctx.s), 0, 'not before 30 minutes');
        await db.query('UPDATE video_upload_ai SET updated_at = $1 WHERE upload_id = $2', [at(31 * 60e3), main]);
        assert.strictEqual(await requeueSummaries(t.ctx.s), 1, 'after 30 minutes');
        assert.strictEqual((await t.ctx.videoAi.forUpload({ id: main })).status, 'queued');
        const page = await vreq(t.base, path, { cookie: samCookie });
        assert.ok(page.text.includes('<track kind="captions"') && page.text.includes('Got some ashwagandha (2)'), 'the first run\'s captions and chapters stay while it is asked again');
        await db.query("UPDATE video_upload_ai SET status = 'done', attempts = 3, updated_at = $1 WHERE upload_id = $2", [at(90 * 60e3), main]);
        assert.strictEqual(await requeueSummaries(t.ctx.s), 0, 'the third: two hours after, not one and a half');
        await db.query("UPDATE video_upload_ai SET attempts = 12, updated_at = $1 WHERE upload_id = $2", [at(3 * 86400e3), main]);
        assert.strictEqual(await requeueSummaries(t.ctx.s), 0, 'twelve attempts in all');
    });

    await t.close();
    await live.close();
    done();
})();
