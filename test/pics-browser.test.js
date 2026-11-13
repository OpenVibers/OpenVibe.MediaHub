'use strict';
/**
 * OpenVibe.Pics' home in a real browser (the owner's 11-13 phone report):
 *   - every icon paints something: a registry glyph with a path in the HTML, never an empty <i> or a zero-size SVG;
 *   - "Choose a picture" shows its words and its upload glyph, is 44 px tall, keeps its pink through a shared sheet that
 *     writes the same `.ovp-btn` class, and takes keyboard focus with a visible ring;
 *   - no button text is the same colour as what is behind it, or invisible through opacity.
 *
 * It boots the Pics host over HTTPS (the app sets upgrade-insecure-requests, so an http page loads no stylesheet) with
 * a throwaway certificate and Chrome's host resolver mapping openvibe.pics to 127.0.0.1. Screenshots of every checked
 * size and theme go to PICS_SHOT_DIR (default: a directory under the system temp dir) and their paths are printed.
 *
 * Skips, with a line saying why, when Playwright, Chrome or openssl is missing.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');

const PLAYWRIGHT = ['playwright', '/home/workstation/openvibe/work/OpenVibe.Games/node_modules/playwright'];
const CHROME = '/usr/bin/google-chrome';
const SHOT_DIR = process.env.PICS_SHOT_DIR || path.join(os.tmpdir(), 'openvibe-pics-shots');
const SIZE_THEMES = [[390, 'dark'], [390, 'light'], [1280, 'dark'], [1280, 'light']];

function playwright() {
    for (const p of PLAYWRIGHT) { try { return require(p); } catch { /* try the next */ } }
    return null;
}
function canRun() {
    if (!playwright()) return 'Playwright is not installed';
    if (!fs.existsSync(CHROME)) return `Chrome is not at ${CHROME}`;
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { return 'openssl is not installed'; }
    return '';
}
function listen(server) { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); }); }

/** Start an HTTPS front for the app; Chrome's host resolver maps openvibe.pics to 127.0.0.1. */
async function httpsFront(base) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pics-cert-'));
    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-subj', '/CN=openvibe.pics', '-days', '1'], { stdio: 'ignore' });
    const target = new URL(base);
    const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
        const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: 'openvibe.pics' } }, (r) => {
            res.writeHead(r.statusCode, r.headers);
            r.pipe(res);
        });
        upstream.on('error', () => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('proxy'); });
        req.pipe(upstream);
    });
    const port = await listen(server);
    return { server, port, dir, close: async () => { await new Promise((r) => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** What the page says about its icons and buttons; every problem is a sentence with the element. */
function audit() {
    const problems = [];
    const painted = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        }
        return true;
    };
    const geometry = (s) => {
        const tag = s.tagName.toLowerCase();
        const num = (v) => Number(v) > 0;
        if (tag === 'path') return (s.getAttribute('d') || '').trim().length > 1;
        if (tag === 'circle' || tag === 'ellipse') return num(s.getAttribute('r')) || (num(s.getAttribute('rx')) && num(s.getAttribute('ry')));
        if (tag === 'rect') return num(s.getAttribute('width')) && num(s.getAttribute('height'));
        if (tag === 'line') return s.getAttribute('x1') != null && s.getAttribute('x2') != null;
        if (tag === 'polyline' || tag === 'polygon') return (s.getAttribute('points') || '').trim().length > 3;
        if (tag === 'use') return Boolean(s.getAttribute('href') || s.getAttribute('xlink:href'));
        return false;
    };
    const describe = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
    const parse = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const behind = (el) => {
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
            const cs = getComputedStyle(n);
            const c = parse(cs.backgroundColor);
            if (c && c.a > 0.05) return c;
            if (cs.backgroundImage && cs.backgroundImage !== 'none') return { r: 0, g: 0, b: 0, a: 1 };
        }
        return parse(getComputedStyle(document.body).backgroundColor) || { r: 0, g: 0, b: 0, a: 1 };
    };
    const iconSelector = '.sc-h-ic, .sc-card .sc-ic, .ovp-glyph, .ovp-gc-ic, .ovp-drop-icon, .ovnav-ic, body [data-ov-icon], body [data-icon]';
    for (const el of document.querySelectorAll(iconSelector)) {
        if (!painted(el)) continue;
        const box = el.getBoundingClientRect();
        if (box.width < 1 || box.height < 1) { problems.push(`${describe(el)} has no size (${Math.round(box.width)}x${Math.round(box.height)})`); continue; }
        const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
        if (svg) {
            const sbox = svg.getBoundingClientRect();
            if (sbox.width < 1 || sbox.height < 1) { problems.push(`${describe(el)} draws a zero-size SVG`); continue; }
            const shapes = [...svg.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse,use')];
            if (!shapes.length || !shapes.some(geometry)) { problems.push(`${describe(el)} has an SVG with no drawing`); continue; }
            const colour = parse(getComputedStyle(svg).color);
            if (colour && colour.a < 0.1) problems.push(`${describe(el)} draws in a transparent colour`);
            continue;
        }
        const img = el.tagName.toLowerCase() === 'img' ? el : el.querySelector('img');
        if (img) { if (!img.complete || !img.naturalWidth) problems.push(`${describe(el)} has a picture that did not load`); continue; }
        problems.push(`${describe(el)} has no SVG or picture`);
    }

    for (const el of document.querySelectorAll('button, .ovp-page .ovp-btn')) {
        if (!painted(el)) continue;
        const text = (el.innerText || '').trim();
        if (!text) continue;
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        const bg = behind(el);
        if (!fg || fg.a < 0.1) { problems.push(`${describe(el)} "${text.slice(0, 30)}" has no visible text colour`); continue; }
        const ratio = contrast(fg, bg);
        if (ratio < 3) problems.push(`${describe(el)} "${text.slice(0, 30)}" has ${ratio.toFixed(2)}:1 text (colour ${cs.color} on ${JSON.stringify(bg)})`);
    }

    const file = document.querySelector('.ovp-file');
    if (!file) problems.push('no "Choose a picture" upload trigger on the home');
    else {
        if (!/Choose a picture/.test(file.innerText || '')) problems.push('the upload trigger has no words');
        const box = file.getBoundingClientRect();
        if (box.height < 44) problems.push(`the upload trigger is ${Math.round(box.height)} px tall, not 44`);
        const glyph = file.querySelector('.ovp-glyph svg');
        if (!glyph) problems.push('the upload trigger has no glyph');
        else if (glyph.getBoundingClientRect().width < 12) problems.push('the upload trigger glyph is too small');
    }
    return problems;
}

(async () => {
    const why = canRun();
    if (why) { process.stdout.write(`pics browser: skipped (${why})\n`); return done(); }
    const { chromium } = playwright();
    const t = await boot();
    const kim = t.network.addUser('kim');
    const shots = [];
    let front = null;
    let browser = null;
    try {
        front = await httpsFront(t.base);
        browser = await chromium.launch({ executablePath: CHROME, args: ['--host-resolver-rules=MAP openvibe.pics 127.0.0.1', '--ignore-certificate-errors'] });
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        for (const [width, theme] of SIZE_THEMES) {
            await check(`${width} px, ${theme}: icons paint, button text is visible, the upload trigger is 44 px and keyboard-focusable`, async () => {
                const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, deviceScaleFactor: 1, isMobile: width < 700, hasTouch: width < 700 });
                try {
                    await context.addCookies([{ name: 'media-hub_at', value: t.network.userToken(kim), domain: 'openvibe.pics', path: '/', secure: true, sameSite: 'Lax' }]);
                    // Paint the chosen theme before the first frame, as a person's saved theme does.
                    await context.addInitScript((id) => { try { if (location.hostname === 'openvibe.pics') localStorage.setItem('ov_theme', JSON.stringify({ id })); } catch { /* no storage */ } }, theme === 'light' ? 'daylight' : 'vibe');
                    const page = await context.newPage();
                    const pageErrors = [];
                    page.on('pageerror', (e) => pageErrors.push(e.message));
                    await page.route('https://openvibe.network/**', (route) => route.fulfill({ status: 204, body: '' }));
                    await page.route('https://openvibe.cam/**', (route) => route.fulfill({ status: 204, body: '' }));
                    await page.goto(`https://openvibe.pics:${front.port}/`, { waitUntil: 'load' });
                    await page.waitForTimeout(600);
                    // The shared presence sheet writes a plain `.ovp-btn` after Pics' own sheet. Inject its real rule so the
                    // check is the same on a page where presence has not arrived yet: Pics' scoped rules must still win.
                    await page.addStyleTag({ content: '.ovp-btn { height: 40px; padding: 0 14px; border-radius: 12px; border: 1px solid var(--border, #333340); background: transparent; color: inherit; font: inherit; font-weight: 650; cursor: pointer; } .ovp-btn:hover { background: color-mix(in srgb, var(--text-primary, #fff) 7%, transparent); }' });
                    await page.waitForTimeout(100);
                    const problems = await page.evaluate(audit);
                    assert.deepStrictEqual(problems, [], `home at ${width} px, ${theme}:\n${problems.join('\n')}`);

                    const focus = await page.evaluate(() => {
                        const input = document.querySelector('.ovp-file input[type=file]');
                        if (!input) return { missing: true };
                        input.focus();
                        const label = input.closest('label');
                        const cs = label && getComputedStyle(label);
                        return {
                            active: document.activeElement === input,
                            inTabOrder: input.tabIndex === 0 && !input.disabled,
                            focusWithin: Boolean(label && label.matches(':focus-within')),
                            ring: Boolean(cs && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2),
                            name: Boolean(input.labels && [...input.labels].some((l) => /Choose a picture/.test(l.innerText || ''))),
                        };
                    });
                    assert.deepStrictEqual(focus, { active: true, inTabOrder: true, focusWithin: true, ring: true, name: true }, 'the upload trigger takes keyboard focus with its ring and its name');

                    const shot = path.join(SHOT_DIR, `pics-home-${width}-${theme}.png`);
                    await page.screenshot({ path: shot, fullPage: true });
                    shots.push(shot);
                    assert.deepStrictEqual(pageErrors, [], `no page errors at ${width} px, ${theme}`);
                } finally {
                    await context.close();
                }
            });
        }
    } finally {
        if (browser) await browser.close();
        if (front) await front.close();
        await t.close();
    }
    process.stdout.write(`pics browser: screenshots ${shots.join(' ')}\n`);
    done();
})().catch((err) => { process.stderr.write(`${err.stack || err}\n`); process.exit(1); });
