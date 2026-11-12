'use strict';
// Every page of openvibe.pics gives the shared navbar Pics' own page list (the owner, 2026-11-12). Shared's legal
// template used to fall back to Home / My Account / Themes on /terms, /privacy and /dmca.
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { NAV_LINKS } = require('../server/pics/layout');

function hostClient(t) {
    return (p) => new Promise((resolve, reject) => {
        const req = http.request({ hostname: new URL(t.base).hostname, port: new URL(t.base).port, path: p, method: 'GET', headers: { Host: 'openvibe.pics' } }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, text: body }));
        });
        req.on('error', reject);
        req.end();
    });
}

/** The links inside a page's OpenVibeNavbar.init({...}) call. */
function initLinks(html) {
    const at = html.indexOf('OpenVibeNavbar.init');
    if (at < 0) return null;
    const start = html.indexOf('links', at);
    const open = html.indexOf('[', start);
    let depth = 0, q = null, esc = false;
    for (let i = open; i < html.length; i += 1) {
        const c = html[i];
        if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '[') depth += 1; else if (c === ']') { depth -= 1; if (!depth) return JSON.parse(html.slice(open, i + 1)); }
    }
    return null;
}

(async () => {
    const t = await boot();
    const get = hostClient(t);
    try {
        const own = NAV_LINKS.map(({ label, href }) => ({ label, href }));
        await check('every page sends Pics\' own list, not the shared fallback', async () => {
            for (const path of ['/', '/updates', ...NAV_LINKS.map((l) => l.href), '/terms', '/privacy', '/dmca']) {
                const r = await get(path);
                assert.ok([200, 302, 401, 403].includes(r.status), `${path} answered ${r.status}`);
                if (r.status !== 200) continue;
                const links = (initLinks(r.text) || []).map(({ label, href }) => ({ label, href }));
                assert.deepStrictEqual(links, own, `${path} sends Pics' list`);
            }
        });
        await check('every row is a route of this host', async () => {
            for (const { href } of NAV_LINKS) {
                const r = await get(href);
                assert.notStrictEqual(r.status, 404, `${href} is a route`);
                assert.ok(r.status < 500, `${href} does not fail (${r.status})`);
            }
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
