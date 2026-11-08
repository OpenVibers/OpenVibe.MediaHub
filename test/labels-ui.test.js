'use strict';
/**
 * Content labels on the pages (L1, server/render/labels-ui.js): openvibe.video's cards and watch pages and
 * OpenVibe.Pics' tiles and picture pages carry data-ov-labels (Shared's ov-labels.js applies each viewer's choice),
 * the maker is named so they always see their own, a thing's own page is "opened" (a hide covers it instead of
 * emptying the page), the labels show in words, and the owners' edit forms set them: the AI's suggestions are marked
 * and never ticked, and ticking nothing clears them.
 *   node test/labels-ui.test.js
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');
const ui = require('../server/render/labels-ui');

// ── The module ──────────────────────────────────────────────────────────────────────────────────────────────────
assert.deepStrictEqual(ui.inForce({ content_labels: { labels: ['nudity', '18+', 'gore'], suggested: ['language'] } }), ['nudity', '18+'], 'the labels in force, known ones only');
assert.deepStrictEqual(ui.inForce({ content_labels: '{"labels":["spoilers"],"suggested":[]}' }), ['spoilers'], 'a jsonb string');
assert.deepStrictEqual(ui.inForce({ content_labels: ['graphic'] }), ['graphic'], 'a bare list');
assert.deepStrictEqual(ui.inForce({ labels: ['flashing'] }), ['flashing'], 'a wire item\'s labels');
assert.deepStrictEqual(ui.inForce({ title: 'x' }), [], 'none');
assert.deepStrictEqual(ui.inForce(null), []);
assert.deepStrictEqual(ui.suggestedOf({ content_labels: { labels: [], suggested: ['language'] } }), ['language']);

assert.strictEqual(ui.ownerAttr('kim'), '@kim', 'a username is named with @');
assert.strictEqual(ui.ownerAttr('@kim'), '@kim');
assert.strictEqual(ui.ownerAttr('user:usr_01ABC'), 'usr_01ABC', 'a stored owner gives its subject');
assert.strictEqual(ui.ownerAttr('usr_01ABC'), 'usr_01ABC', 'a bare subject');
assert.strictEqual(ui.ownerAttr('anon:abc'), null, 'an anonymous upload has no owner to name');
assert.strictEqual(ui.ownerAttr('bad name'), null);
assert.strictEqual(ui.ownerAttr(null), null);

assert.strictEqual(String(ui.attrs([])), '', 'nothing for no labels');
assert.strictEqual(String(ui.attrs(['nudity', '18+'], { owner: 'kim' })), ' data-ov-labels="nudity,18+" data-ov-labels-owner="@kim"');
assert.strictEqual(String(ui.attrs(['18+'], { opened: true })), ' data-ov-labels="18+" data-ov-labels-opened', 'its own page');

const chips = String(ui.chips(['language', '18+']));
assert.ok(chips.startsWith('<ul class="ovk-labels" aria-label="Content labels">'), chips);
assert.ok(chips.includes('<li class="ovk-label" data-label="language">Strong language</li>'), 'in words');
assert.ok(chips.includes('<li class="ovk-label ovk-label--adult" data-label="18+">18+</li>'), '18+ in the warning colour');
assert.strictEqual(String(ui.chips([])), '');

const pick = String(ui.picker({ content_labels: { labels: ['nudity'], suggested: ['flashing', 'nudity'] } }, { what: 'the clip', id: 'lx' }));
assert.strictEqual((pick.match(/<input type="checkbox" name="labels" value="/g) || []).length, 6, 'one toggle per label');
assert.ok(pick.includes('value="nudity" checked>'), 'a label in force is ticked');
assert.ok(!pick.includes('value="flashing" checked'), 'a suggestion is never ticked for the creator');
assert.strictEqual((pick.match(/class="ovl-sug">Suggested</g) || []).length, 1, 'only a suggestion not already in force is marked');
assert.ok(pick.includes('<input type="hidden" name="labels_form" value="1">'), 'the form says the picker was there');
assert.ok(pick.includes('never takes the clip down') && pick.includes('aria-describedby="lx-help"') && pick.includes('id="lx-help"'), 'the help names the thing and is tied to the fieldset');

assert.strictEqual(ui.fromForm({ title: 'x' }), undefined, 'no picker: keep what it has');
assert.deepStrictEqual(ui.fromForm({ labels_form: '1' }), [], 'the picker with nothing ticked clears them');
assert.deepStrictEqual(ui.fromForm({ labels_form: '1', labels: 'language' }), ['language'], 'one ticked arrives as a string');
assert.deepStrictEqual(ui.fromForm({ labels_form: '1', labels: ['18+', 'nudity', '18+'] }), ['18+', 'nudity']);
assert.strictEqual(ui.fromForm({ labels_form: '1', labels: ['gore'] }), null, 'not a label');

// ── The pages ───────────────────────────────────────────────────────────────────────────────────────────────────
const usernameOf = (auth) => {
    const tok = String(auth || '').replace(/^Bearer /, '');
    try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString('utf8')).username || null; } catch { return null; }
};

/** A Live that keeps a VOD and a clip with their labels, and records what it is asked to change. */
function startLive() {
    const vods = {
        301: { id: 301, title: 'Kim labelled', duration_seconds: 45, created_at: '2026-10-12T10:00:00.000Z', playback_url: 'https://openvibe.media/v/301', visibility: 'public', username: 'kim', display_name: 'Kim',
            content_labels: { labels: ['nudity', '18+'], suggested: ['flashing'] } },
    };
    const clips = {
        401: { id: 401, vod_id: 301, title: 'Kim clip', start_time: 5, end_time: 15, duration_seconds: 10, playback_url: 'https://openvibe.media/c/401', visibility: 'public', username: 'kim', display_name: 'Kim',
            content_labels: { labels: ['spoilers'], suggested: [] } },
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
            const m = /^\/api\/(vods|clips)\/(\d+)(\/title|\/visibility|\/labels)?$/.exec(url.pathname);
            if (m) {
                const store = m[1] === 'vods' ? vods : clips;
                const item = store[m[2]];
                if (!item) return json(404, { error: 'not found' });
                if (req.method === 'GET') return json(200, m[1] === 'vods' ? { vod: item, clips: Object.values(clips) } : { clip: item });
                if (who !== item.username) return json(403, { error: 'Not authorized' });
                const { labels, ...rest } = body || {};
                Object.assign(item, rest);
                if (labels !== undefined) item.content_labels = { labels, suggested: item.content_labels.suggested.filter((l) => !labels.includes(l)) };
                return json(200, m[1] === 'vods' ? { vod: item } : { message: 'ok' });
            }
            if (url.pathname === '/api/vods' || /^\/api\/users\/[^/]+\/vods$/.test(url.pathname)) return json(200, { vods: Object.values(vods), hasMore: false, total: 1 });
            if (url.pathname === '/api/clips' || /^\/api\/users\/[^/]+\/clips$/.test(url.pathname)) return json(200, { clips: Object.values(clips) });
            return json(404, { error: 'not found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, vods, clips, calls, close: () => new Promise((r) => server.close(r)) })));
}

/** A request to the app with a Host header (Node's fetch drops Host); form may be pairs, to repeat a field. */
function hreq(base, host, path, { method = 'GET', cookie, form, body, type, same = true } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: host };
        if (cookie) h.cookie = cookie;
        if (same && method !== 'GET') h['sec-fetch-site'] = 'same-origin';
        let data = body;
        if (form) { data = Buffer.from(new URLSearchParams(form).toString()); h['content-type'] = 'application/x-www-form-urlencoded'; }
        if (type) h['content-type'] = type;
        if (data != null) h['content-length'] = String(Buffer.byteLength(data));
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        if (data != null) req.write(data);
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
    const video = (path, o) => hreq(t.base, 'openvibe.video', path, o);
    const pics = (path, o) => hreq(t.base, 'openvibe.pics', path, o);
    try {
        await check('a recording\'s own page: labelled, its maker named, opened, the labels in words', async () => {
            const r = await video('/v/301');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('<div class="ovv-player-wrap" data-ov-labels="nudity,18+" data-ov-labels-owner="@kim" data-ov-labels-opened>'), 'the player is the labelled thing');
            assert.ok(/<h1 class="ovv-title">Kim labelled<\/h1>\s*<ul class="ovk-labels" aria-label="Content labels"><li class="ovk-label" data-label="nudity">Nudity<\/li><li class="ovk-label ovk-label--adult" data-label="18\+">18\+<\/li><\/ul>/.test(r.text), 'the chips under the title');
            assert.ok(!r.text.includes('Flashing lights'), 'a suggestion is never shown to viewers');
            assert.ok(!r.text.includes('name="labels"'), 'no picker for a viewer');
        });

        await check('cards: the picture in a cover outside the hidden link, the chips under the title', async () => {
            const r = await video('/@kim');
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('<article class="ovv-card" data-ov-labels="nudity,18+" data-ov-labels-owner="@kim">'), 'the card is labelled');
            assert.ok(/<div class="ovv-card-cover" data-ov-labels-media><a class="ovv-card-media" href="\/v\/301" tabindex="-1" aria-hidden="true">/.test(r.text), 'the cover wraps the link, so Show is never inside aria-hidden');
            assert.ok(r.text.includes('<article class="ovv-card" data-ov-labels="spoilers" data-ov-labels-owner="@kim">'), 'the clip card too');
            const page = await video('/v/301');
            assert.ok(page.text.includes('<div class="ovv-card-cover" data-ov-labels-media><a class="ovv-card-media" href="/c/401"'), 'the clips beside the player');
        });

        await check('the owner\'s form: in force ticked, the AI\'s suggestion marked and not ticked', async () => {
            const r = await video('/v/301', { cookie: kimCookie });
            assert.ok(r.text.includes('who can see it, labels</span>'), 'the panel says it holds the labels');
            assert.ok(/<link rel="stylesheet" href="\/css\/labels\.css(\?v=[0-9a-f]+)?">/.test(r.text), 'the picker\'s sheet, on the owner\'s page only');
            assert.ok(!(await video('/v/301')).text.includes('css/labels.css'), 'a viewer\'s page does not load it');
            assert.ok(r.text.includes('value="nudity" checked>') && r.text.includes('value="18+" checked>'), 'in force');
            assert.ok(/value="flashing"><span class="ovl-card"><b>Flashing lights<\/b><small>[^<]+<\/small><em class="ovl-sug">Suggested<\/em>/.test(r.text), 'the suggestion, unticked and marked');
            assert.ok(!(await video('/v/301', { cookie: samCookie })).text.includes('name="labels"'), 'not for someone else');
        });

        await check('saving the recording sends the labels; ticking nothing clears them; a stray value is refused', async () => {
            let r = await video('/v/301/manage', { method: 'POST', cookie: kimCookie, form: [['title', 'Kim labelled'], ['visibility', 'public'], ['labels_form', '1'], ['labels', '18+'], ['labels', 'flashing']] });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            assert.deepStrictEqual(live.calls.pop().body.labels, ['18+', 'flashing']);
            assert.deepStrictEqual(live.vods[301].content_labels, { labels: ['18+', 'flashing'], suggested: [] }, 'the confirmed suggestion left the suggestions');
            r = await video('/v/301/manage', { method: 'POST', cookie: kimCookie, form: [['title', 'Kim labelled'], ['visibility', 'public'], ['labels_form', '1']] });
            assert.strictEqual(r.status, 303);
            assert.deepStrictEqual(live.calls.pop().body.labels, [], 'nothing ticked is no labels');
            const n = live.calls.length;
            r = await video('/v/301/manage', { method: 'POST', cookie: kimCookie, form: [['title', 'Kim labelled'], ['visibility', 'public'], ['labels_form', '1'], ['labels', 'gore']] });
            assert.strictEqual(r.status, 422);
            assert.strictEqual(live.calls.length, n, 'Live was never called');
        });

        await check('a clip\'s labels are sent only when they changed', async () => {
            const n = live.calls.length;
            let r = await video('/c/401/manage', { method: 'POST', cookie: kimCookie, form: [['title', 'Kim clip'], ['visibility', 'public'], ['labels_form', '1'], ['labels', 'spoilers']] });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            assert.strictEqual(live.calls.length, n, 'nothing changed, nothing sent');
            r = await video('/c/401/manage', { method: 'POST', cookie: kimCookie, form: [['title', 'Kim clip'], ['visibility', 'public'], ['labels_form', '1'], ['labels', 'spoilers'], ['labels', 'language']] });
            assert.strictEqual(r.status, 303);
            assert.deepStrictEqual(live.calls.slice(n).map((c) => [c.method, c.path, c.body]), [['PUT', '/api/clips/401/labels', { labels: ['spoilers', 'language'] }]]);
        });

        await check('Pics: the picture\'s page and its tile carry the labels; the uploader sets them from the form', async () => {
            const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#335' } }).jpeg().toBuffer();
            const up = await pics('/api/v1/images', { method: 'POST', cookie: kimCookie, body: jpeg, type: 'image/jpeg' });
            assert.strictEqual(up.status, 201, up.text);
            const slug = JSON.parse(up.text).slug;
            let r = await pics(`/i/${slug}`);
            assert.ok(!r.text.includes('data-ov-labels'), 'no labels, nothing marked');
            r = await pics(`/i/${slug}`, { cookie: kimCookie });
            assert.ok(r.text.includes('<legend>Content labels</legend>') && r.text.includes('never takes the picture down'), 'the uploader\'s form has the picker');
            assert.ok(r.text.includes('css/labels.css') && !(await pics(`/i/${slug}`)).text.includes('css/labels.css'), 'the sheet for the uploader only');
            r = await pics(`/i/${slug}/edit`, { method: 'POST', cookie: kimCookie, form: [['title', 'Beach'], ['description', ''], ['alt', ''], ['labels_form', '1'], ['labels', 'nudity']] });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            r = await pics(`/i/${slug}`);
            assert.ok(r.text.includes(`<figure class="ovp-figure" data-ov-labels="nudity" data-ov-labels-owner="${kim.subject}" data-ov-labels-opened>`), 'the figure: labelled, its uploader by subject, opened');
            assert.ok(/<h1 class="ovp-title">Beach<\/h1>\s*<ul class="ovk-labels"[^>]*><li class="ovk-label" data-label="nudity">Nudity<\/li><\/ul>/.test(r.text), 'the chips under the title');
            r = await pics('/mine', { cookie: kimCookie });
            assert.ok(r.text.includes(`<div class="ovp-tile-cover" data-ov-labels="nudity" data-ov-labels-owner="${kim.subject}"><a class="ovp-tile" href="/i/${slug}">`), 'the tile in its cover');
            r = await pics(`/i/${slug}/edit`, { method: 'POST', cookie: kimCookie, form: [['title', 'Beach'], ['labels_form', '1'], ['labels', 'gore']] });
            assert.strictEqual(r.status, 422, 'not a label');
            r = await pics(`/i/${slug}/edit`, { method: 'POST', cookie: kimCookie, form: [['title', 'Beach'], ['labels_form', '1']] });
            assert.strictEqual(r.status, 303);
            assert.ok(!(await pics(`/i/${slug}`)).text.includes('data-ov-labels'), 'ticking nothing cleared them');
        });
    } finally {
        await t.close();
        await live.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
