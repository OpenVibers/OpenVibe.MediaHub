'use strict';
/**
 * Alt text on OpenVibe.Pics (server/pics/describe.js): only the uploader's press sends a picture to OpenVibe.AI
 * (pics.describe_image, the 640-pixel WebP thumbnail as a data URL); the draft becomes the alt text in the page, the
 * thumbnails and the embed snippets, with the caption labelled as AI's. An edit makes the alt text the uploader's;
 * the site's daily cap and AI failures answer plainly; a hidden picture is never sent.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');
const { draftOf } = require('../server/pics/describe');

function startAi(handler) {
    const runs = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const body = raw ? JSON.parse(raw) : null;
            runs.push({ method: req.method, path: req.url, body, auth: req.headers.authorization });
            const out = handler(body);
            res.writeHead(out.status || 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(out.body || {}));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ runs, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

/** A request with Host: openvibe.pics (Node's fetch drops a Host header). */
function picsClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', 'sec-fetch-site': 'same-origin', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

const OUTPUT = { alt: 'A picture of an orange sky over a green field with a white sun', caption: 'Bright blocks of colour: orange above, a green field below.', tags: ['Sky', 'field', 'sky', 'sun'], gaps: [] };

(async () => {
    await check('the draft: "image of" goes, the first letter is upper case, tags are lowercase and unique; no alt, no draft', () => {
        assert.deepStrictEqual(draftOf(OUTPUT), { alt: 'An orange sky over a green field with a white sun', caption: 'Bright blocks of colour: orange above, a green field below.', tags: ['sky', 'field', 'sun'] });
        assert.strictEqual(draftOf({ caption: 'x' }), null);
        assert.strictEqual(draftOf(null), null);
    });

    let mode = 'ok';
    const ai = await startAi(() => {
        if (mode === 'fail') return { status: 503, body: { code: 'ai.unavailable' } };
        if (mode === 'slow') return { status: 202, body: { run: { id: 'run_2', status: 'running' } } };
        return { status: 201, body: { run: { id: 'run_1', status: 'succeeded', output: OUTPUT } } };
    });
    const t0 = await boot({ env: { OV_AI_INTERNAL_URL: ai.url, MEDIAHUB_PICS_AI_PER_DAY: '2' } });
    const t = { ...t0, get: picsClient(t0) };
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const picture = (bg) => sharp({ create: { width: 900, height: 600, channels: 3, background: bg } }).jpeg().toBuffer();
        const up = async (as, bg, title) => (await t.get('/api/v1/images', { as, method: 'POST', body: await picture(bg), headers: { 'content-type': 'image/jpeg', 'x-title': encodeURIComponent(title) } })).json();
        const a = await up(kim, '#f80', 'Sunset');
        const b = await up(kim, '#08f', 'Sea');
        const c = await up(kim, '#0f8', 'Grass');

        await check('before anyone asks, nothing goes to OpenVibe.AI and the title is the alt text', async () => {
            const pg = await t.get(`/i/${a.slug}`, { as: kim });
            assert.ok(pg.text.includes('alt="Sunset"'));
            assert.ok(pg.text.includes('Write alt text with AI'), 'the uploader sees the button');
            assert.ok(!(await t.get(`/i/${a.slug}`, { as: lee })).text.includes('Write alt text with AI'), 'nobody else does');
            assert.strictEqual(ai.runs.length, 0);
        });

        await check('the uploader asks: the thumbnail goes as a WebP data URL to pics.describe_image; the draft is the alt text everywhere', async () => {
            const r = await t.get(`/i/${a.slug}/describe`, { as: kim, form: {} });
            assert.strictEqual(r.status, 200, r.text.slice(0, 300));
            assert.ok(r.text.includes('AI wrote the alt text below'));
            assert.strictEqual(ai.runs.length, 1);
            const run = ai.runs[0];
            assert.strictEqual(run.body.workflow, 'pics.describe_image');
            assert.match(run.body.input.image.data_url, /^data:image\/webp;base64,/);
            assert.strictEqual(run.body.input.title, 'Sunset');
            assert.deepStrictEqual(run.body.target, { service: 'media-hub', type: 'picture', id: a.id });
            assert.match(run.auth, /^Bearer /);

            const pg = await t.get(`/i/${a.slug}`);
            assert.ok(pg.text.includes('alt="An orange sky over a green field with a white sun"'), 'the picture');
            assert.ok(pg.text.includes('Described by AI') && pg.text.includes('Bright blocks of colour'), 'the caption, labelled');
            assert.ok(pg.text.includes('![An orange sky over a green field with a white sun](https://openvibe.pics/i/'), 'the Markdown snippet');
            const wire = (await t.get(`/api/v1/images/${a.slug}`)).json();
            assert.strictEqual(wire.alt_source, 'ai');
            assert.deepStrictEqual(wire.ai.tags, ['sky', 'field', 'sun']);
            assert.ok((await t.get('/mine', { as: kim })).text.includes('alt="An orange sky over a green field with a white sun"'), 'the thumbnails');
        });

        await check('only the uploader can ask; a hidden picture is never sent', async () => {
            const r = await t.get(`/api/v1/images/${a.slug}/describe`, { as: lee, method: 'POST', json: {} });
            assert.strictEqual(r.status, 403);
            await t0.ctx.s.db.exec("UPDATE pics_images SET state = 'hidden' WHERE id = $1", [c.id]);
            const h = await t.get(`/api/v1/images/${c.slug}/describe`, { as: kim, method: 'POST', json: {} });
            assert.strictEqual(h.status, 409);
            assert.strictEqual(h.json().code, 'pics.not_active');
            await t0.ctx.s.db.exec("UPDATE pics_images SET state = 'active' WHERE id = $1", [c.id]);
            assert.strictEqual(ai.runs.length, 1);
        });

        await check('saving the form unchanged keeps it AI\'s; an edit makes it the uploader\'s and the AI caption goes', async () => {
            await t.get(`/i/${a.slug}/edit`, { as: kim, form: { title: 'Sunset', description: '', alt: 'An orange sky over a green field with a white sun' } });
            assert.strictEqual((await t.get(`/api/v1/images/${a.slug}`)).json().alt_source, 'ai');
            await t.get(`/i/${a.slug}/edit`, { as: kim, form: { title: 'Sunset', description: '', alt: 'Sunset over the fields behind our house' } });
            const wire = (await t.get(`/api/v1/images/${a.slug}`)).json();
            assert.deepStrictEqual([wire.alt, wire.alt_source], ['Sunset over the fields behind our house', 'person']);
            assert.ok(!(await t.get(`/i/${a.slug}`)).text.includes('Described by AI'));
            const api = await t.get(`/api/v1/images/${a.slug}`, { as: kim, method: 'PATCH', json: { alt: '' } });
            assert.deepStrictEqual([api.json().alt, api.json().alt_source], ['', null], 'cleared: back to the title');
        });

        await check('a failure or a slow run answers plainly and keeps what was there', async () => {
            mode = 'fail';
            const f = await t.get(`/api/v1/images/${b.slug}/describe`, { as: kim, method: 'POST', json: {} });
            assert.deepStrictEqual([f.status, f.json().code], [502, 'pics.ai_failed']);
            mode = 'slow';
            const s = await t.get(`/i/${b.slug}/describe`, { as: kim, form: {} });
            assert.strictEqual(s.status, 503);
            assert.ok(s.text.includes('taking longer than usual'));
            assert.strictEqual((await t.get(`/api/v1/images/${b.slug}`)).json().alt, '');
        });

        await check('the daily cap for the whole site', async () => {
            mode = 'ok';
            assert.strictEqual((await t.get(`/api/v1/images/${b.slug}/describe`, { as: kim, method: 'POST', json: {} })).status, 200);
            const capped = await t.get(`/api/v1/images/${c.slug}/describe`, { as: kim, method: 'POST', json: {} });
            assert.deepStrictEqual([capped.status, capped.json().code], [429, 'pics.ai_daily_cap']);
        });
    } finally {
        await t0.close();
        await ai.close();
    }

    await check('off: no button and 503 without OV_AI_INTERNAL_URL', async () => {
        const t1 = await boot();
        const t = { ...t1, get: picsClient(t1) };
        try {
            const kim = t.network.addUser('kim');
            const img = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#333' } }).png().toBuffer();
            const up = (await t.get('/api/v1/images', { as: kim, method: 'POST', body: img, headers: { 'content-type': 'image/png' } })).json();
            assert.ok(!(await t.get(`/i/${up.slug}`, { as: kim })).text.includes('Write alt text with AI'));
            const r = await t.get(`/api/v1/images/${up.slug}/describe`, { as: kim, method: 'POST', json: {} });
            assert.deepStrictEqual([r.status, r.json().code], [503, 'pics.ai_off']);
        } finally {
            await t1.close();
        }
    });

    done();
})();
