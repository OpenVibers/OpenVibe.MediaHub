'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const posts = [];
    const fetchImpl = async (url, init) => {
        if (!url.startsWith('https://openvibe.community/api/v1/comments')) return fetch(url, init);
        if (url.endsWith('/threads/resolve')) return Response.json({ thread: { id: 'cth_1234567890123456789012' } });
        if (init.method === 'GET') {
            const q = new URL(url).searchParams;
            if (q.has('parent')) return Response.json({ comments: [{ id: 3, parent_id: 1, message: 'third reply', author: { username: 'reader', display_name: 'Reader' } }], next_cursor: null });
            return Response.json({ thread: { id: 'cth_1234567890123456789012', url: 'https://openvibe.community/c/cth_1234567890123456789012' },
                comments: [{ id: 1, message: 'On the picture', author: { username: 'reader', display_name: 'Reader' }, created_at: '2026-11-10T12:00:00Z',
                    reply_count: 3, replies: [{ id: 2, parent_id: 1, reply_to_id: 1, reply_to: { display_name: 'Reader' }, message: 'first reply' }],
                    attachments: [{ id: 'med_01JAB2C3D4E5F6G7H8J9K0MNP6', name: 'look.png', media_type: 'image/png' }] }],
                viewer: { can_comment: true }, next_cursor: null });
        }
        if (init.method === 'POST') { posts.push(JSON.parse(init.body)); return Response.json({ comment: { id: 4 } }, { status: 201 }); }
        throw new Error(`Unexpected Community call: ${url}`);
    };
    const t = await boot({ fetchImpl });
    const person = t.network.addUser('picturewriter');
    const request = (path, { method = 'GET', body = null, headers = {}, signedIn = false } = {}) => new Promise((resolve, reject) => {
        const target = new URL(t.base);
        const req = http.request({ hostname: target.hostname, port: target.port, path, method,
            headers: { Host: 'openvibe.pics', ...(signedIn ? { Cookie: t.signIn(person) } : {}), ...(body ? { 'Content-Length': body.length } : {}), ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (part) => chunks.push(part));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, location: res.headers.location }); });
        });
        req.on('error', reject);
        req.end(body);
    });
    try {
        const photo = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#a84' } }).jpeg().toBuffer();
        const uploaded = await request('/api/v1/images', { method: 'POST', body: photo, signedIn: true,
            headers: { Origin: 'https://openvibe.pics', 'Content-Type': 'image/jpeg' } });
        assert.equal(uploaded.status, 201, uploaded.text.slice(0, 400));
        const slug = JSON.parse(uploaded.text).slug;
        await check('picture page renders comments, replies, target and attachment for signed-out visitors', async () => {
            const page = await request(`/i/${slug}`);
            assert.equal(page.status, 200, page.text.slice(0, 400));
            for (const value of ['ovc-thread', 'On the picture', 'first reply', 'ovc-target', 'ovc-more', 'ovc-attach', 'Sign in to comment'])
                assert.ok(page.text.includes(value), value);
        });
        await check('picture composer posts through the Pics proxy to Community', async () => {
            const page = await request(`/i/${slug}`, { signedIn: true });
            assert.match(page.text, /data-ovt-composer/);
            const boundary = 'pics-comment-test';
            const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nA new comment\r\n--${boundary}--\r\n`);
            const sent = await request(`/i/${slug}/comments`, { method: 'POST', body, signedIn: true,
                headers: { Origin: 'https://openvibe.pics', 'Sec-Fetch-Site': 'same-origin', 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
            assert.equal(sent.status, 303, sent.text.slice(0, 400));
            assert.deepEqual(posts[0], { message: 'A new comment', parent_id: null, attachments: [] });
        });
    } finally { await t.close(); }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
