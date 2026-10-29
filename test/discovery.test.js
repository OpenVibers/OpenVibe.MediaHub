'use strict';
/**
 * The public crawl artifacts (plan T11), fetched from the booted app: /robots.txt, /sitemap.xml,
 * /llms.txt, /llms-full.txt and the home page's JSON-LD. Each is served with the right status and
 * content type, carries at least one real entry, lists public pages only, and takes lastmod from the
 * site's own data (STATUS.json) — never from the clock.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

const STATUS_UPDATED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'STATUS.json'), 'utf8')).updated;
// llms.txt names the public machine endpoints on purpose, so only sign-in and the API are private there.
const PRIVATE = ['/auth/', '/api/'];

/** A GET with a chosen Host, through node's http: fetch() silently drops a Host header, and this app routes on it. */
function onHost(base, p, host) {
    const u = new URL(base);
    return new Promise((resolve, reject) => {
        http.get({ host: u.hostname, port: u.port, path: p, headers: { host } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: body }));
        }).on('error', reject);
    });
}

(async () => {
    const t = await boot();
    try {
        await check('security.txt: RFC 9116 on every host, canonical to that host', async () => {
            // The drive host, then the two product hosts that share this app, each with its own Canonical.
            for (const site of ['openvibe.download', 'openvibe.video', 'openvibe.pics']) {
                const r = await onHost(t.base, '/.well-known/security.txt', site);
                const where = site;
                assert.strictEqual(r.status, 200, `${where} answers security.txt`);
                assert.strictEqual(r.headers['content-type'], 'text/plain; charset=utf-8', `${where} is text/plain; charset=utf-8`);
                assert.strictEqual(r.headers['cache-control'], 'public, max-age=86400', `${where} is cached for a day`);
                const fields = new Map();
                for (const line of r.text.split('\n')) if (line.trim()) {
                    const m = line.match(/^([A-Za-z-]+): (.+)$/);
                    assert.ok(m, `${where}: every line is "Name: value" (got "${line}")`);
                    fields.set(m[1], m[2]);
                }
                for (const key of ['Contact', 'Expires', 'Preferred-Languages', 'Canonical', 'Policy']) assert.ok(fields.has(key), `${where} names ${key}`);
                assert.strictEqual(fields.get('Contact'), 'mailto:security@openvibe.network');
                assert.ok(Date.parse(fields.get('Expires')) > Date.now(), `${where}: Expires is in the future`);
                const canonical = new URL(fields.get('Canonical'));
                assert.strictEqual(canonical.host, site, `${where}: Canonical is the site's own host`);
                assert.strictEqual(canonical.pathname, '/.well-known/security.txt');
            }
        });

        await check('robots.txt: 200 text/plain, sign-in and the API disallowed, the public pages crawlable, sitemap named', async () => {
            const r = await t.get('/robots.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const d of ['/auth/', '/api/']) assert.ok(r.text.includes(`Disallow: ${d}`), `missing Disallow: ${d}`);
            for (const d of ['/updates']) assert.ok(!r.text.includes(`Disallow: ${d}`), `${d} must stay crawlable`);
            assert.ok(r.text.includes('Sitemap: https://openvibe.download/sitemap.xml'), 'sitemap not named');
            assert.ok(/^User-agent: \*$/m.test(r.text), 'no User-agent: * group');
        });

        await check('sitemap.xml: 200 application/xml, real entries, lastmod from the data', async () => {
            const r = await t.get('/sitemap.xml');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^application\/xml/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            for (const p of ['/', '/updates']) assert.ok(r.text.includes(`<loc>https://openvibe.download${p}</loc>`), `no ${p} entry`);
            for (const p of ['/auth/login', '/api/v1/ping']) assert.ok(!r.text.includes(`<loc>https://openvibe.download${p}</loc>`), `${p} is not a public page`);
            const lastmods = [...r.text.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
            assert.ok(lastmods.length > 0, 'no lastmod anywhere');
            assert.ok(lastmods.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)), `bad lastmod: ${lastmods.slice(0, 3)}`);
            assert.ok(lastmods.every((d) => d === STATUS_UPDATED), `lastmod must come from STATUS.json (${STATUS_UPDATED}), got ${[...new Set(lastmods)].join(', ')}`);
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.download${p}`), `private path in sitemap: ${p}`);
        });

        await check('llms.txt: 200 text/plain, real links, nothing private', async () => {
            const r = await t.get('/llms.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Download'), 'no title');
            assert.ok(r.text.includes('(https://openvibe.download/updates)'), 'no updates link');
            assert.ok(r.text.includes('(https://openvibe.services)'), 'no pointer to the developer platform');
            assert.ok(r.text.includes('https://openvibe.download/sitemap.xml'), 'sitemap not listed');
            assert.ok(r.text.includes('(https://openvibe.download/llms-full.txt)'), 'llms-full.txt not listed');
            for (const p of ['/auth/']) assert.ok(!r.text.includes(`https://openvibe.download${p}`), `private path in llms.txt: ${p}`);
        });

        await check('llms-full.txt: 200 text/plain, the site title, and every page the sitemap lists', async () => {
            const r = await t.get('/llms-full.txt');
            assert.strictEqual(r.status, 200);
            assert.match(r.headers.get('content-type'), /^text\/plain/);
            assert.match(r.headers.get('cache-control') || '', /public, max-age=\d+/);
            assert.ok(r.text.startsWith('# OpenVibe.Download'), 'no title');
            const sitemap = await t.get('/sitemap.xml');
            const locs = [...sitemap.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
            assert.ok(locs.length >= 2, `sitemap too small: ${locs.length}`);
            for (const loc of locs) assert.ok(r.text.includes(loc), `llms-full.txt is missing ${loc}`);
            assert.ok(r.text.includes('URL: https://openvibe.download/updates\n'), 'no /updates entry');
            for (const p of PRIVATE) assert.ok(!r.text.includes(`https://openvibe.download${p}`), `private path in llms-full.txt: ${p}`);
        });

        await check('home page: WebSite + the site\'s primary type, the same for every crawler', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200);
            const blocks = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
            const types = blocks.map((b) => b['@type']);
            assert.ok(types.includes('WebSite'), `no WebSite node: ${types}`);
            assert.ok(types.includes('WebApplication'), `no primary-type node: ${types}`);
            const site = blocks.find((b) => b['@type'] === 'WebSite');
            assert.strictEqual(site.url, 'https://openvibe.download');
            assert.strictEqual(site.name, 'OpenVibe.Download');
            const page = blocks.find((b) => b['@type'] === 'WebPage');
            assert.strictEqual(page.url, 'https://openvibe.download/');
        });
    } finally { await t.close(); }
    done();
})();
