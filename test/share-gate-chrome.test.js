'use strict';
/**
 * The "not on the list" gate in a real headless Chrome (openvibe-shared 4.123.0's [data-ov-share-gate]),
 * on the pics host: markup only; signed out it offers Sign in, a signed-in stranger is offered Ask for
 * access, and the page has no console error and no CSP refusal. Skipped without Chrome.
 */
const assert = require('assert');
const fs = require('fs');
const sharp = require('sharp');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');

/** The page's own /shared asset, fetched over plain HTTP from 127.0.0.1 with the pics Host. */
function sharedFile(url) {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
        const q = http.request({ hostname: '127.0.0.1', port: u.port, path: u.pathname + u.search, headers: { Host: u.hostname } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        q.on('error', reject);
        q.end();
    });
}

let playwright = null;
try { playwright = require('playwright'); } catch {
    try { playwright = require(process.env.PLAYWRIGHT_MODULE || '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'); } catch { playwright = null; }
}
const CHROME = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (process.env.OV_SKIP_BROWSER === '1' || !playwright || !fs.existsSync(CHROME)) {
    console.log('share-gate-chrome: skipped (no Chrome; set CHROME_BIN)');
    process.exit(0);
}
const REFUSED = /Content Security Policy|Refused to (?:load|execute|apply)|Uncaught SyntaxError/i;

(async () => {
    const t = await boot({ env: { MEDIAHUB_PICS_URL: 'http://pics.test' } });
    const kate = t.network.addUser('kate');
    const sam = t.network.addUser('sam');
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#336699' } }).png().toBuffer();
    const out = await t.ctx.pics.upload({ requester: `user:${kate.subject}` }, { buffer: png, name: 'a.png' }, { title: 'Secret picture' });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const picture = out.image;
    await t.ctx.sharing.shares.setAudience(
        { subject: { type: 'user', id: kate.subject } }, { service: 'mediahub', kind: 'picture', id: picture.id }, 'people',
    );
    const port = new URL(t.base).port;
    const origin = `http://pics.test:${port}`;
    const url = `${origin}/i/${picture.slug}`;
    const [cookieName, ...cookieRest] = t.signIn(sam).split('=');

    let browser;
    const errors = [];
    const watch = (p) => {
        p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        p.on('pageerror', (e) => errors.push(String(e)));
    };
    const settled = async (p) => {
        await p.waitForSelector('#share-gate .ov-share-gate', { timeout: 8000 });
        return await p.$eval('#share-gate', (el) => el.textContent.replace(/\s+/g, ' ').trim());
    };

    try {
        await check('headless Chrome: the gate draws itself, signed out, with Sign in', async () => {
            browser = await playwright.chromium.launch({
                executablePath: CHROME, headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage', '--host-resolver-rules=MAP pics.test 127.0.0.1'],
            });
            const ctx = await browser.newContext();
            const p = await ctx.newPage();
            await p.route('**/shared/**', async (r) => {
                const res = await sharedFile(r.request().url());
                const headers = { ...res.headers };
                delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
                await r.fulfill({ status: res.status, headers, body: res.body });
            });
            watch(p);
            const res = await p.goto(url, { waitUntil: 'load', timeout: 15000 });
            const text = await settled(p);
            assert.ok(/Sign in/.test(text), `signed out the gate offers Sign in, got: ${text}`);
            const href = await p.$eval('#share-gate .ov-share-gate a', (a) => a.getAttribute('href'));
            assert.match(href, /^\/auth\/login\?next=/);
            await ctx.close();
        });

        await check('headless Chrome: a stranger is offered Ask for access', async () => {
            const ctx = await browser.newContext();
            await ctx.addCookies([{ name: cookieName, value: cookieRest.join('='), url: origin }]);
            const p = await ctx.newPage();
            await p.route('**/shared/**', async (r) => {
                const res = await sharedFile(r.request().url());
                const headers = { ...res.headers };
                delete headers['content-encoding']; delete headers['content-length']; delete headers['transfer-encoding'];
                await r.fulfill({ status: res.status, headers, body: res.body });
            });
            watch(p);
            await p.goto(url, { waitUntil: 'load', timeout: 15000 });
            const text = await settled(p);
            assert.ok(/Ask for access/.test(text), `a stranger is offered Ask for access, got: ${text}`);
            assert.ok(/@sam/.test(text), 'the gate names the account it is signed in as');
            await ctx.close();
        });

        await check('headless Chrome: no console error and no CSP refusal', async () => {
            assert.deepStrictEqual(errors.filter((e) => REFUSED.test(e)), []);
        });
    } finally {
        if (browser) await browser.close().catch(() => {});
        await t.close();
        done();
    }
})();
