'use strict';
/**
 * The VOD picture-in-picture in a real headless Chrome, with two short local videos:
 *   - the PIP follows a seek on the main one (its currentTime is offset + (main - from)), and works across
 *     several seeks;
 *   - pause, speed and the end of the span follow too, and drift over 0.3 s is corrected with a playbackRate nudge;
 *   - a tap on the box swaps it with the main view and a second tap swaps back;
 *   - a span whose VOD is missing says so once, quietly, and draws no PIP.
 *
 *   node test/vod-pip-chrome.test.js
 *   PLAYWRIGHT_PATH=/path/to/playwright CHROME_BIN=/usr/bin/google-chrome node test/vod-pip-chrome.test.js
 *
 * Skips (exit 0) when neither Playwright nor Chrome is available, like the shared browser tests.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

function findPlaywright() {
    for (const where of [process.env.PLAYWRIGHT_PATH, 'playwright', '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright']) {
        if (!where) continue;
        try { return require(where); } catch { /* next */ }
    }
    return null;
}
const playwright = findPlaywright();
const chrome = process.env.CHROME_BIN || '/usr/bin/google-chrome';
if (!playwright || !fs.existsSync(chrome)) {
    console.log(`vod-pip-chrome: skipped (${playwright ? 'no Chrome' : 'no Playwright'}; set PLAYWRIGHT_PATH / CHROME_BIN)`);
    process.exit(0);
}

const root = path.join(__dirname, '..');
const sharedRoot = path.dirname(require.resolve('openvibe-shared/files'));
const fixture = (name) => fs.readFileSync(path.join(root, 'test', 'fixtures', name));
const PIP = {
    vod_id: 801, file: '/pip.webm', hls: null, from: 1, to: 5, offset: 0.5,
    x: 0.66, y: 0.14, w: 0.3, muted: true, title: 'Robot camera', href: '/v/801',
};
const MISSING = { vod_id: 899, missing: true, file: null, hls: null, from: 4.5, to: 5.5, offset: 0, x: 0.1, y: 0.1, w: 0.2, muted: true, title: 'Gone camera', href: '/v/899' };

const page0 = `<!doctype html><meta charset="utf-8"><title>VOD PiP test</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#111;color:#eee;font:14px system-ui}#frame{position:relative;width:640px;height:360px;background:#000;margin:20px}
#main{width:100%;height:100%;display:block;object-fit:contain}</style>
<div id="frame" class="ov-player"><video id="main" src="/main.webm" playsinline preload="metadata"></video></div>
<script src="/ov-float.js"></script>
<script src="/vod-pip.js"></script>
<script>
window.attachCalls = 0;
function attachSource(video) { window.attachCalls += 1; return Promise.resolve('file'); }
window.api = VodPip.attach(document.getElementById('main'), {
    data: ${JSON.stringify([PIP, MISSING])},
    attachSource: attachSource,
});
</script>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/main.webm' || url.pathname === '/pip.webm') {
        const data = fixture(url.pathname === '/main.webm' ? 'vod-main.webm' : 'vod-pip.webm');
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
            res.writeHead(206, {
                'content-type': 'video/webm', 'cache-control': 'no-store', 'accept-ranges': 'bytes',
                'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': end - start + 1,
            });
            res.end(data.subarray(start, end + 1));
            return;
        }
        res.writeHead(200, { 'content-type': 'video/webm', 'cache-control': 'no-store', 'accept-ranges': 'bytes', 'content-length': data.length });
        res.end(data);
        return;
    }
    if (url.pathname === '/ov-float.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(fs.readFileSync(path.join(sharedRoot, 'ov-float.js')));
        return;
    }
    if (url.pathname === '/vod-pip.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end(fs.readFileSync(path.join(root, 'public', 'js', 'vod-pip.js')));
        return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page0);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sample = (page) => page.evaluate(() => {
    const main = document.getElementById('main');
    const box = document.querySelector('.ovv-pip');
    const pip = box && box.querySelector('video');
    return {
        main: main.currentTime, mainPaused: main.paused, mainRate: main.playbackRate, mainSrc: main.getAttribute('src') || '',
        boxHidden: !box || box.hidden, pip: pip ? pip.currentTime : null, pipPaused: pip ? pip.paused : null,
        pipRate: pip ? pip.playbackRate : null, pipSrc: pip ? (pip.getAttribute('src') || '') : '',
        note: (document.querySelector('.ovv-pip-note') || {}).textContent || '',
    };
});
const mapped = (main) => PIP.offset + (main - PIP.from);

(async () => {
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}/`;
    const browser = await playwright.chromium.launch({
        executablePath: chrome,
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
        await page.goto(base, { waitUntil: 'load' });
        await page.waitForFunction(() => document.getElementById('main').readyState >= 1);
        // Let the first seek land before playing (play() during a seek cancels it in Chrome).
        await page.evaluate(() => { const m = document.getElementById('main'); m.muted = true; m.currentTime = 2; });
        await wait(300);
        await page.evaluate(() => document.getElementById('main').play());

        // The first frame of the PIP: shown inside the span, playing at the mapped second.
        await page.waitForFunction(() => {
            const box = document.querySelector('.ovv-pip');
            const v = box && box.querySelector('video');
            return box && !box.hidden && v && v.readyState >= 2 && !v.paused;
        }, null, { timeout: 12000 });
        await wait(600);
        let s = await sample(page);
        assert.ok(!s.boxHidden, 'the PIP shows inside its span');
        assert.ok(Math.abs(s.pip - mapped(s.main)) < 0.35, `at the mapped second (main ${s.main.toFixed(2)}, PIP ${s.pip.toFixed(2)}, want ${mapped(s.main).toFixed(2)})`);
        assert.ok(s.pipRate >= 0.95 && s.pipRate <= 1.05, `at the main's speed (${s.pipRate})`);

        // A seek on the main seeks the PIP.
        for (const at of [3.5, 2.25, 4.2]) {
            await page.evaluate((t) => { document.getElementById('main').currentTime = t; }, at);
            await wait(450);
            s = await sample(page);
            assert.ok(!s.boxHidden, `the PIP is still shown after seeking to ${at}`);
            assert.ok(Math.abs(s.pip - mapped(s.main)) < 0.35, `a seek to ${at} moves the PIP (main ${s.main.toFixed(2)}, PIP ${s.pip.toFixed(2)}, want ${mapped(s.main).toFixed(2)})`);
        }

        // Pause follows.
        await page.evaluate(() => document.getElementById('main').pause());
        await wait(350);
        s = await sample(page);
        assert.ok(s.pipPaused, 'pausing the main pauses the PIP');
        const frozen = s.pip;
        await wait(400);
        s = await sample(page);
        assert.equal(s.pip, frozen, 'and it stays put');

        // Rate follows (with the small nudge allowed for drift).
        await page.evaluate(() => { const m = document.getElementById('main'); m.playbackRate = 1.4; return m.play(); });
        await wait(700);
        s = await sample(page);
        assert.ok(s.pipRate >= 1.4 * 0.95 - 0.01 && s.pipRate <= 1.4 * 1.05 + 0.01, `the PIP plays at the main's 1.4× (${s.pipRate})`);

        // Drift over 0.3 s is nudged, not frozen.
        await page.evaluate(() => { document.getElementById('main').currentTime = 2.6; });
        await wait(350);
        await page.evaluate(() => {
            const v = document.querySelector('.ovv-pip video');
            v.currentTime = Math.max(0, v.currentTime - 0.7);
        });
        await wait(450);
        s = await sample(page);
        assert.ok(s.pipRate > 1.4, `behind the main it speeds up (${s.pipRate})`);

        // The end of the span hides it (no frozen last frame). Pause first so the main does not run past 5 while we look.
        await page.evaluate(() => document.getElementById('main').pause());
        await wait(300);
        await page.evaluate(() => { document.getElementById('main').currentTime = 5.4; });
        await wait(400);
        s = await sample(page);
        assert.ok(s.boxHidden, 'outside [from, to) the PIP hides');
        assert.ok(s.pipPaused, 'and stops playing');

        // The missing PIP's span: no box, one quiet note.
        await page.evaluate(() => { document.getElementById('main').currentTime = 4.7; });
        await wait(400);
        s = await sample(page);
        assert.match(s.note, /Gone camera/, 'a span whose VOD is missing says which one');
        assert.ok(!s.boxHidden, 'the other PIP still shows');

        // Back inside; then a tap on the box swaps it with the main view.
        await page.evaluate(() => { const m = document.getElementById('main'); m.currentTime = 2.2; return m.play(); });
        await wait(500);
        const rect = await page.evaluate(() => {
            const r = document.querySelector('.ovv-pip').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(rect.x, rect.y);
        await page.waitForFunction(() => (document.getElementById('main').getAttribute('src') || '').endsWith('/pip.webm')
            && document.querySelector('.ovv-pip').classList.contains('is-swapped'), null, { timeout: 8000 });
        s = await sample(page);
        assert.equal(s.mainSrc, '/pip.webm', 'the main view plays the PIP recording after a tap');
        assert.match(s.pipSrc, /main\.webm$/, 'and the floating view plays the main recording');
        assert.ok(!s.boxHidden, 'the swapped view stays visible');

        // A second tap swaps back.
        const rect2 = await page.evaluate(() => {
            const r = document.querySelector('.ovv-pip').getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        });
        await page.mouse.click(rect2.x, rect2.y);
        await page.waitForFunction(() => (document.getElementById('main').getAttribute('src') || '').endsWith('/main.webm')
            && !document.querySelector('.ovv-pip').classList.contains('is-swapped'), null, { timeout: 8000 });
        s = await sample(page);
        assert.equal(s.mainSrc, '/main.webm', 'the second tap brings the main recording back');
        assert.match(s.pipSrc, /pip\.webm$/, 'and the PIP returns to the box');

        assert.deepEqual(errors, [], 'no page errors');
        process.stdout.write('  ✓ the PIP follows seeks, pause, rate, drift and the span; a tap swaps it; a missing one says so\n');
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
    }
})().catch((err) => { console.error(err); server.close(() => process.exit(1)); });
