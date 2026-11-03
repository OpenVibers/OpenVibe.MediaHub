'use strict';
/**
 * SEO-1: the Markdown twins of openvibe.pics' public pages (server/pics/agent-pages.js). A twin is the page's own
 * render for an anonymous browser; the page names it in its head and in the Link: header when it answered 200 to
 * someone who is not signed in. A picture's page, a signed-in page and a missing page name none.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

function get(t, p, { cookie, accept } = {}) {
    return new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics' };
        if (cookie) headers.cookie = cookie;
        if (accept) headers.accept = accept;
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.end();
    });
}

const PAGES = ['/', '/exif', '/content-policy', '/ai-training', '/updates'];

(async () => {
    const t = await boot();
    try {
        await check('each public page names its twin in the head and the Link header, and the twin is the page', async () => {
            for (const p of PAGES) {
                const page = await get(t, p);
                assert.strictEqual(page.status, 200, p);
                const twinPath = p === '/' ? '/index.md' : `${p}.md`;
                const href = `https://openvibe.pics${twinPath}`;
                assert.ok(page.text.includes(`<link rel="alternate" type="text/markdown" href="${href}">`), `${p} names its twin in the head`);
                assert.ok(String(page.headers.link || '').includes(`<${href}>; rel="alternate"; type="text/markdown"`), `${p} names it in the Link header`);
                const twin = await get(t, twinPath);
                assert.strictEqual(twin.status, 200, twinPath);
                assert.ok(/^text\/markdown/.test(twin.headers['content-type']), `${twinPath} is Markdown`);
                assert.ok(twin.text.startsWith('---\ntitle:') && twin.text.includes(`canonical: "https://openvibe.pics${p}"`), `${twinPath} is the pics page`);
                assert.ok(!/<(?:script|style)\b/i.test(twin.text.replace(/~~~~[\s\S]*?~~~~/g, '')) && twin.text.length > 150, `${twinPath} is the page's words`);
            }
        });

        await check('the drive and the video host keep their own pages', async () => {
            const drive = await new Promise((resolve, reject) => {
                const u = new URL(t.base + '/index.md');
                http.get({ hostname: u.hostname, port: u.port, path: '/index.md', headers: { Host: 'openvibe.download' } }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
                }).on('error', reject);
            });
            assert.ok(!drive.text.includes('canonical: "https://openvibe.pics'), "the drive's twin is not the pics home");
        });

        await check('a picture, a missing page and a signed-in page name no twin', async () => {
            const missing = await get(t, '/no-such-page');
            assert.ok(!/text\/markdown/.test(missing.text) && !/text\/markdown/.test(String(missing.headers.link || '')), 'a missing page');
            assert.strictEqual((await get(t, '/i/nosuchpicture.md')).status, 404, 'a picture has no twin');
            const kim = t.network.addUser('kim-pics');
            const mine = await get(t, '/exif', { cookie: t.signIn(kim) });
            assert.strictEqual(mine.status, 200);
            assert.ok(!/type="text\/markdown"/.test(mine.text) && !/text\/markdown/.test(String(mine.headers.link || '')), 'a signed-in page');
        });
    } finally {
        await t.close();
    }
    done();
})();
