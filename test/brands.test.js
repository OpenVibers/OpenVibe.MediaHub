'use strict';
/**
 * One process, three brand surfaces (the media-hub product manifest). The Host header decides which one a request
 * is for, and v1 has launched only openvibe.download: openvibe.pics and openvibe.video answer an honest "coming"
 * page and nothing else — no drive, no share links, no API and above all no uploads, because neither brand has the
 * safety tooling its content needs yet.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

const PICS = { 'x-forwarded-host': 'openvibe.pics' };
const VIDEO = { 'x-forwarded-host': 'openvibe.video' };

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const other = t.network.addUser('sam');
    const file = (await upload(t, kim, bytes(120, 'brand'), { name: 'brand.bin' })).json().file;
    const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;

    await check('openvibe.pics and openvibe.video answer a coming home that says what they will be', async () => {
        const pics = await t.get('/', { headers: PICS });
        assert.strictEqual(pics.status, 200);
        assert.match(pics.headers.get('content-type'), /^text\/html/);
        assert.ok(pics.text.includes('OpenVibe.Pics'), 'the brand');
        assert.ok(pics.text.includes('Share pictures. Fast, open, yours.'), 'its own tagline');
        assert.ok(pics.text.includes('Albums &amp; galleries') || pics.text.includes('Albums & galleries'), 'what it will be');
        assert.ok(/safety tooling/i.test(pics.text), 'why it is not open yet');
        assert.ok(/no malware or CSAM scanning/i.test(pics.text), 'said plainly');
        assert.ok(pics.text.includes('https://openvibe.download'), 'a link to the brand that has launched');

        const video = await t.get('/', { headers: VIDEO });
        assert.strictEqual(video.status, 200);
        assert.ok(video.text.includes('OpenVibe.Video'));
        assert.ok(video.text.includes('Your videos, everywhere.'));
        assert.ok(/safety tooling/i.test(video.text));
        assert.ok(video.text.includes('https://openvibe.download'));
    });

    await check('nothing else exists on those brands: no drive, no share, no API, no upload', async () => {
        const before = t.media.requests.length;
        for (const headers of [PICS, VIDEO]) {
            const brand = headers['x-forwarded-host'];
            for (const p of ['/files', `/files/${file.id}`, `/files/${file.id}/download`, `/s/${slug}`, `/s/${slug}/download`, `/staff`, '/api/v1/ping']) {
                const r = await t.get(p, { as: kim, headers });
                assert.strictEqual(r.status, 404, `${brand} ${p} answered ${r.status}`);
            }
            // The write routes too — with a real file behind them.
            const up = await t.get('/api/v1/files', { as: kim, headers: { ...headers, ...SAME }, json: { name: 'x.bin', size: 10, content_type: 'text/plain' } });
            assert.strictEqual(up.status, 404, `${brand}: the API is not there`);
            const form = await t.get('/files/upload', { as: kim, method: 'POST', headers: { ...headers, ...SAME, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=x' });
            assert.strictEqual(form.status, 404, `${brand}: no form upload`);
        }
        assert.strictEqual(t.media.requests.length, before, 'and OpenVibe.Media was never called');
    });

    await check('the crawl artifacts and the update log are the same on every brand', async () => {
        for (const headers of [{}, PICS, VIDEO]) {
            assert.strictEqual((await t.get('/updates', { headers })).status, 200);
            assert.strictEqual((await t.get('/robots.txt', { headers })).status, 200);
            assert.strictEqual((await t.get('/sitemap.xml', { headers })).status, 200);
            assert.strictEqual((await t.get('/llms.txt', { headers })).status, 200);
        }
    });

    await check('the launched brand is untouched, and an unknown host is the launched brand', async () => {
        assert.ok((await t.get('/')).text.includes('OpenVibe.Download'));
        assert.ok((await t.get('/')).text.includes('private drive'));
        for (const headers of [{ 'x-forwarded-host': 'openvibe.download' }, { 'x-forwarded-host': 'www.openvibe.download' }, { 'x-forwarded-host': '127.0.0.1' }, { 'x-forwarded-host': 'openvibe.host' }]) {
            const r = await t.get('/', { headers });
            assert.ok(r.text.includes('OpenVibe.Download'), JSON.stringify(headers));
        }
        assert.strictEqual((await t.get('/files', { as: kim })).status, 200);
        assert.strictEqual((await t.get(`/s/${slug}`, { as: other })).status, 200, 'and its share links work');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
