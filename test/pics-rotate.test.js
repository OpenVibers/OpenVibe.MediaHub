'use strict';
// A picture's owner turns it a quarter from its page: plain kit buttons, a form POST (works without JavaScript), the
// picture and its stored thumbnail both turned in Media with the owner as X-OV-Subject, and the page's size follows.
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

/** t.get with a Host header (Node's fetch drops one): the pics host only answers on openvibe.pics. */
function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] || null }, text, json() { return JSON.parse(text); } }); });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

const PICS = { Host: 'openvibe.pics' };
const SAME = { ...PICS, 'sec-fetch-site': 'same-origin' };
const photo = () => sharp({ create: { width: 300, height: 200, channels: 3, background: '#357' } }).jpeg({ quality: 90 }).toBuffer();

(async () => {
    const booted = await boot();
    const t = { ...booted, get: hostClient(booted) };
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const up = async (as) => t.get('/api/v1/images', { as, method: 'POST', body: await photo(), headers: { ...SAME, 'content-type': 'image/jpeg', 'x-title': 'Sideways' } });
        let slug;
        await check('the owner sees the Rotate control, a stranger does not', async () => {
            const made = await up(kim);
            assert.strictEqual(made.status, 201, `upload answered ${made.status}: ${made.text.replace(/\s+/g, ' ').slice(0, 200)}`);
            slug = made.json().slug;
            assert.deepStrictEqual([made.json().width, made.json().height], [300, 200]);
            const ownerPage = await t.get(`/i/${slug}`, { headers: PICS, as: kim });
            assert.ok(ownerPage.text.includes(`action="/i/${slug}/rotate"`), 'the owner has the turn form');
            assert.ok(ownerPage.text.includes('>Turn left<') && ownerPage.text.includes('>Turn right<'), 'both directions, plain kit buttons');
            assert.ok(ownerPage.text.includes('class="ovk-btn ovk-btn--quiet"'));
            assert.ok(!(await t.get(`/i/${slug}`, { headers: PICS, as: lee })).text.includes(`/i/${slug}/rotate`), 'a stranger never sees it');
        });

        await check('a right turn turns the picture and its thumbnail in Media, as the owner', async () => {
            const before = t.media.requests.length;
            const r = await t.get(`/i/${slug}/rotate`, { as: kim, method: 'POST', form: { direction: 'right' }, headers: SAME });
            assert.strictEqual(r.status, 303, r.text);
            assert.strictEqual(r.headers.get('location'), `/i/${slug}?turned=1`);
            const calls = t.media.requests.slice(before).filter((x) => /\/rotate$/.test(x.path));
            assert.strictEqual(calls.length, 2, 'the picture and its stored thumbnail both turn');
            assert.ok(calls.every((c) => c.subject === kim.subject), 'Media sees the owner, never the service alone');
            assert.ok(calls.every((c) => c.authorization === 'Bearer svc-media'), 'and the service token');
            const row = await t.ctx.s.db.maybe('SELECT width, height, sha256 FROM pics_images WHERE slug = $1', [slug]);
            assert.deepStrictEqual([Number(row.width), Number(row.height)], [200, 300], 'the page size follows the turn');
            const objects = [...t.media.objects.values()].filter((o) => o.rotation === 90);
            assert.ok(objects.length >= 2, 'the stand-in Media recorded a 90-degree turn on both objects');
            const page = await t.get(`/i/${slug}?turned=1`, { headers: PICS, as: kim });
            assert.ok(page.text.includes('Turned a quarter.'), 'the page says what happened');
        });

        await check('someone else cannot turn it', async () => {
            const before = t.media.requests.length;
            const r = await t.get(`/i/${slug}/rotate`, { as: lee, method: 'POST', form: { direction: 'left' }, headers: SAME });
            assert.strictEqual(r.status, 403);
            assert.strictEqual(t.media.requests.slice(before).filter((x) => /\/rotate$/.test(x.path)).length, 0, 'nothing reached Media');
        });

        await check('a cross-site form post never turns it', async () => {
            const r = await t.get(`/i/${slug}/rotate`, { as: kim, method: 'POST', form: { direction: 'left' }, headers: { ...PICS, 'sec-fetch-site': 'cross-site' } });
            assert.strictEqual(r.status, 403);
        });
    } finally { await t.close(); }
    done();
})();
