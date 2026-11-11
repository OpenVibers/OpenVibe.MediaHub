'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const posts = [];
    const live = http.createServer((req, res) => {
        const path = new URL(req.url, 'http://local').pathname;
        const json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
        if (path === '/api/vods/101') return json({ vod: { id: 101, title: 'A recording', visibility: 'public', username: 'maker',
            created_at: '2026-11-10T12:00:00Z', duration_seconds: 60, playback_url: 'https://openvibe.media/v/101' }, clips: [] });
        if (path === '/api/comments/vod/101' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => { posts.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); res.statusCode = 201; json({ comment: { id: 8 } }); });
            return;
        }
        if (path === '/api/comments/vod/101') return json({ thread: { id: 'cth_1234567890123456789012', url: 'https://openvibe.community/c/cth_1234567890123456789012' },
            comments: [{ id: 7, message: 'Good video', username: 'reader', display_name: 'Reader', created_at: '2026-11-10T12:00:00Z', reply_count: 0 }], viewer: { can_comment: true } });
        return json({});
    });
    await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${live.address().port}`;
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: url,
        MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live', MEDIAHUB_CHAT_URL: url, MEDIAHUB_SEARCH_URL: url, MEDIAHUB_VIDEO_SEARCH: 'off' } });
    const videoRequest = (path, { method = 'GET', headers = {}, body = null } = {}) => new Promise((resolve, reject) => {
        const target = new URL(t.base);
        const request = http.request({ hostname: target.hostname, port: target.port, path, method,
            headers: { Host: 'openvibe.video', ...(body ? { 'Content-Length': body.length } : {}), ...headers } }, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        request.on('error', reject);
        request.end(body);
    });
    try {
        await check('recording renders the Community thread and a signed-out sign-in action', async () => {
            const r = await videoRequest('/v/101');
            assert.equal(r.status, 200, `${t.logs().slice(-1200)}\n${r.text.slice(0, 400)}`);
            assert.match(r.text, /class="ovc-thread"/);
            assert.match(r.text, /Good video/);
            assert.match(r.text, /Sign in to comment/);
        });
        await check('signed-in recording shows the shared composer and posts through Live', async () => {
            const person = t.network.addUser('threadwriter');
            const cookie = t.signIn(person);
            const page = await videoRequest('/v/101', { headers: { Cookie: cookie } });
            assert.equal(page.status, 200, page.text.slice(0, 300));
            assert.match(page.text, /data-ovt-composer/);
            const boundary = 'inline-thread-test';
            const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nA new comment\r\n--${boundary}--\r\n`);
            const sent = await videoRequest('/v/101/comments?sort=new', { method: 'POST', body,
                headers: { Cookie: cookie, Origin: 'https://openvibe.video', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
            assert.equal(sent.status, 303, `${sent.text.slice(0, 300)}\n${t.logs().slice(-600)}`);
            assert.deepEqual(posts[0], { message: 'A new comment', parent_id: null, attachments: [] });
        });
    } finally { await t.close(); await new Promise((resolve) => live.close(resolve)); }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
