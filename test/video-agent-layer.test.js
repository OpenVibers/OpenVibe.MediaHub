'use strict';
/**
 * The agent layer (openvibe-shared/agent-layer) on openvibe.video: /.well-known/agent.json, and a Markdown twin of
 * the home, a recording's and a clip's watch page. A twin is the page's own render, so it cannot drift; a twin
 * request (a .md path, ?format=markdown or an explicit text/markdown preference) is the only thing the layer
 * answers — a browser's request is the app's own page, because a watch page is not one page (the owner's Manage
 * panel, a signed-in person's playlist form) and the layer renders every page signed out.
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
        101: { id: 101, title: 'Kim stream', description: 'First', duration_seconds: 3600, created_at: '2026-10-12T10:00:00.000Z', playback_url: 'https://openvibe.media/v/101', visibility: 'public', username: 'kim', display_name: 'Kim' },
        103: { id: 103, title: 'Kim private', description: '', duration_seconds: 20, created_at: '2026-10-12T09:00:00.000Z', playback_url: 'https://openvibe.media/v/103', visibility: 'private', username: 'kim', display_name: 'Kim' },
    };
    const clips = {
        201: { id: 201, vod_id: 101, title: 'Kim clip', start_time: 5, end_time: 15, duration_seconds: 10, playback_url: 'https://openvibe.media/c/201', visibility: 'public', username: 'kim', display_name: 'Kim' },
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const who = usernameOf(req.headers.authorization);
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        const m = /^\/api\/(vods|clips)\/(\d+)$/.exec(url.pathname);
        if (m) {
            const item = (m[1] === 'vods' ? vods : clips)[m[2]];
            if (!item) return json(404, { error: 'not found' });
            if (item.visibility === 'private' && !(who && who === item.username)) return json(404, { error: 'not found' });
            return json(200, m[1] === 'vods' ? { vod: item, clips: [] } : { clip: item });
        }
        if (url.pathname === '/api/vods') return json(200, { vods: Object.values(vods).filter((v) => v.visibility === 'public'), hasMore: false });
        if (url.pathname === '/api/clips') return json(200, { clips: Object.values(clips).filter((c) => c.visibility === 'public') });
        return json(404, { error: 'not found' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

function vreq(base, path, { method = 'GET', cookie, host = 'openvibe.video', accept } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + path);
        const h = { Host: host };
        if (cookie) h.cookie = cookie;
        if (accept) h.accept = accept;
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

(async () => {
    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: live.url } });
    const kim = t.network.addUser('kim');
    const kimCookie = t.signIn(kim);

    await check('the manifest is the video host\'s own', async () => {
        const r = await vreq(t.base, '/.well-known/agent.json');
        assert.strictEqual(r.status, 200);
        assert.ok(/^application\/json/.test(r.headers['content-type']), 'JSON');
        const d = JSON.parse(r.text);
        assert.strictEqual(d.id, 'video');
        assert.strictEqual(d.site, 'openvibe.video');
        assert.strictEqual(d.home, 'https://openvibe.video');
        assert.strictEqual(d.api, 'https://openvibe.video/api/v1/video', 'the API is absolute, on this host');
        assert.strictEqual(d.llms, 'https://openvibe.video/llms.txt');
        assert.strictEqual(d.sitemap, 'https://openvibe.video/sitemap.xml');
        assert.deepStrictEqual(d.policy.auth, ['none', 'Network OIDC']);
        const drive = await vreq(t.base, '/.well-known/agent.json', { host: 'openvibe.download' });
        assert.strictEqual(drive.status, 200, 'the drive answers with its own manifest');
        const dd = JSON.parse(drive.text);
        assert.strictEqual(dd.id, 'download', 'the drive does not answer with the video manifest');
        assert.strictEqual(dd.site, 'openvibe.download');
    });

    await check('a recording\'s twin is the page\'s own render', async () => {
        const r = await vreq(t.base, '/v/101.md');
        assert.strictEqual(r.status, 200);
        assert.ok(/^text\/markdown/.test(r.headers['content-type']), 'markdown');
        assert.ok(r.text.startsWith('---\ntitle: '), 'front matter first');
        assert.ok(r.text.includes('canonical: "https://openvibe.video/v/101"'), 'the twin names its page');
        assert.ok(r.text.includes('# Kim stream'), 'the page\'s own title');
        assert.ok(r.text.includes('First'), 'and its description');
        const clip = await vreq(t.base, '/c/201.md');
        assert.strictEqual(clip.status, 200);
        assert.ok(clip.text.includes('# Kim clip') && clip.text.includes('canonical: "https://openvibe.video/c/201"'), 'a clip has its twin too');
        const home = await vreq(t.base, '/index.md');
        assert.strictEqual(home.status, 200);
        assert.ok(home.text.includes('canonical: "https://openvibe.video/"'), 'and so does the home');
    });

    await check('the HTML page names its twin, in the head and the Link header', async () => {
        const r = await vreq(t.base, '/v/101');
        assert.strictEqual(r.status, 200);
        assert.ok(/<link rel="alternate" type="text\/markdown" href="https:\/\/openvibe\.video\/v\/101\.md">/.test(r.text), 'the head names the twin');
        assert.ok(/<link rel="describedby" href="\/llms\.txt">/.test(r.text), 'and llms.txt');
        assert.ok(r.headers.link.includes('<https://openvibe.video/v/101.md>; rel="alternate"; type="text/markdown"'), 'the Link header too');
        assert.ok(!(await vreq(t.base, '/search')).headers.link, 'a page with no twin claims none');
    });

    await check('a preference for markdown gets the twin from the page path', async () => {
        const r = await vreq(t.base, '/v/101', { accept: 'text/markdown' });
        assert.strictEqual(r.status, 200);
        assert.ok(/^text\/markdown/.test(r.headers['content-type']), 'markdown, not HTML');
        assert.ok(r.text.includes('# Kim stream'));
        const q = await vreq(t.base, '/v/101?format=markdown');
        assert.ok(/^text\/markdown/.test(q.headers['content-type']), '?format=markdown is the twin');
    });

    await check('a signed-in page is never replaced by the signed-out render', async () => {
        const mine = await vreq(t.base, '/v/101', { cookie: kimCookie });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.text.includes('Edit this recording'), 'the owner panel is still there');
        assert.ok(mine.headers.link.includes('/v/101.md'), 'and the page still names its twin');
        // The twin itself is the signed-out render: it carries no owner controls, whoever asks.
        const twin = await vreq(t.base, '/v/101.md', { cookie: kimCookie });
        assert.ok(!twin.text.includes('Edit this recording'), 'the twin is public and signed out');
    });

    await check('a private recording and a missing page have no twin', async () => {
        assert.strictEqual((await vreq(t.base, '/v/103.md')).status, 404, 'a private recording is not a twin');
        assert.strictEqual((await vreq(t.base, '/v/999.md')).status, 404, 'nor is a missing one');
        assert.strictEqual((await vreq(t.base, '/v/999')).status, 404, 'and the page is a real 404');
    });

    await live.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
