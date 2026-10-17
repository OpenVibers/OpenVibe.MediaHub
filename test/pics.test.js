'use strict';
/**
 * OpenVibe.Pics (server/pics) on Host: openvibe.pics. A person uploads a picture (the API or the plain form); it is
 * re-encoded with its metadata gone, stored as private Media objects and served from /i/<slug>.<ext>; its page has
 * the links to share and embed. Others cannot change it; reports hide it (a child-safety report at once); a staff
 * takedown deletes it and blocks the same picture or a near-duplicate from coming back. Albums. Signed-out uploads
 * only when MEDIAHUB_PICS_ANONYMOUS=1, with a delete key and the idle sweep. The drive and Pics never answer on each
 * other's host.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');

/**
 * t.get with a Host header (Node's fetch drops one, so this is http.request): the same options — as, json, form, body,
 * headers, method — and the same answer shape.
 */
function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                const text = buf.toString('utf8');
                resolve({ status: res.statusCode, headers: { get: (k) => res.headers[String(k).toLowerCase()] || null }, text, buffer: buf, json() { return JSON.parse(text); } });
            });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

const PICS = { Host: 'openvibe.pics' };
const SAME = { ...PICS, 'sec-fetch-site': 'same-origin' };

const photo = (bg = '#335', w = 1200, h = 800) => sharp({ create: { width: w, height: h, channels: 3, background: bg } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect width="${w}" height="${h / 2}" fill="#f80"/><circle cx="${w * 0.66}" cy="${h * 0.62}" r="${h / 4}" fill="#eee"/><rect x="${w / 12}" y="${h * 0.56}" width="${w / 4}" height="${h / 3}" fill="#2a2"/></svg>`) }]);

function multipart(fields, file) {
    const b = `----ovp${Date.now()}`;
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buffer, Buffer.from(`\r\n--${b}--\r\n`));
    return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${b}` };
}

(async () => {
    const jpegWithSecrets = await photo().withMetadata({ orientation: 6, exif: { IFD0: { Make: 'SecretCam', Copyright: 'someone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 45/1 0/1' } } }).jpeg({ quality: 92 }).toBuffer();
    const t0 = await boot();
    const t = { ...t0, get: hostClient(t0) };
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const ana = t.network.addUser('ana');
        const boss = t.network.addUser('boss', { role: 'admin' });
        const up = (as, buf, { type = 'image/jpeg', title = '' } = {}) => t.get('/api/v1/images', { as, method: 'POST', body: buf, headers: { ...SAME, 'content-type': type, ...(title ? { 'x-title': encodeURIComponent(title) } : {}) } });
        let slug;
        let direct;

        await check('the hosts stay apart: Pics on openvibe.pics, the drive on openvibe.download', async () => {
            const home = await t.get('/', { headers: PICS });
            assert.strictEqual(home.status, 200);
            assert.ok(home.text.includes('Share pictures.') && home.text.includes('Sign in to upload'));
            assert.ok(/<script type="application\/ld\+json">[^<]*"@type":"WebSite"/.test(home.text), 'the home says what the site is (JSON-LD)');
            assert.strictEqual((await t.get('/files', { headers: PICS, as: kim })).status, 404, 'no drive pages on the pics host');
            assert.ok((await t.get('/', { headers: { Host: 'openvibe.download' } })).text.indexOf('Share pictures.') === -1, 'the drive host is not Pics');
            assert.strictEqual((await t.get('/robots.txt', { headers: PICS })).text.includes('Disallow: /i/'), true, 'pictures are not crawled');
        });

        await check('signed out, uploads are refused until MEDIAHUB_PICS_ANONYMOUS is on', async () => {
            const r = await t.get('/api/v1/images', { method: 'POST', body: jpegWithSecrets, headers: { ...SAME, 'content-type': 'image/jpeg' } });
            assert.strictEqual(r.status, 401);
            assert.strictEqual(r.json().code, 'pics.sign_in_required');
        });

        await check('an upload is re-encoded without its EXIF (GPS, camera), turned upright, and stored private in Media', async () => {
            const r = await up(kim, jpegWithSecrets, { title: 'The coast' });
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            slug = b.slug;
            direct = `/i/${slug}.jpg`;
            assert.match(slug, /^[2-9a-km-zA-HJ-NP-Z]{8}$/);
            assert.deepStrictEqual([b.title, b.ext, b.width, b.height, b.state], ['The coast', 'jpg', 800, 1200, 'active'], 'orientation 6 is applied: 1200×800 becomes 800×1200');
            assert.strictEqual(b.links.direct, `https://openvibe.pics${direct}`);
            assert.ok(b.links.bbcode.includes(`[img]https://openvibe.pics${direct}[/img]`));
            const objects = [...t.media.objects.values()];
            assert.ok(objects.length >= 2 && objects.every((o) => o.visibility === 'private'), 'private Media objects: only this service serves them');

            const file = await t.get(direct, { headers: PICS });
            assert.strictEqual(file.status, 200);
            assert.strictEqual(file.headers.get('content-type'), 'image/jpeg');
            assert.strictEqual(file.headers.get('x-content-type-options'), 'nosniff');
            assert.match(file.headers.get('content-security-policy'), /sandbox/);
            assert.strictEqual(file.headers.get('cache-control'), 'public, max-age=600, s-maxage=600');
            const meta = await sharp(file.buffer).metadata();
            assert.strictEqual(meta.exif, undefined, 'no EXIF block');
            assert.ok(!file.buffer.includes(Buffer.from('SecretCam')), 'the camera name is gone');
            const thumb = await t.get(`/i/${slug}/thumb.webp`, { headers: PICS });
            assert.strictEqual(thumb.status, 200);
            assert.strictEqual((await sharp(thumb.buffer).metadata()).format, 'webp');
            assert.strictEqual((await t.get(`/i/${slug}.png`, { headers: PICS })).status, 404, 'only its own extension');
        });

        await check('what is not a JPEG, PNG, GIF, WebP or AVIF picture is refused', async () => {
            assert.strictEqual((await up(kim, Buffer.from('<?php system($_GET[1]); ?>'.repeat(20)))).json().code, 'pics.not_an_image');
            assert.strictEqual((await up(kim, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><script>alert(1)</script></svg>'), { type: 'image/svg+xml' })).json().code, 'pics.unsupported');
            assert.strictEqual((await up(kim, jpegWithSecrets.subarray(0, 4000))).json().code, 'pics.not_an_image', 'a truncated file');
            const notImage = await t.get('/api/v1/images', { as: kim, method: 'POST', body: Buffer.from('hello'), headers: { ...SAME, 'content-type': 'text/plain' } });
            assert.strictEqual(notImage.status, 415);
        });

        await check('the picture page: the links to share and embed, noindex, and the share image', async () => {
            const page = await t.get(`/i/${slug}`, { headers: PICS });
            assert.strictEqual(page.status, 200);
            assert.ok(page.text.includes('The coast'));
            assert.ok(page.text.includes(`value="https://openvibe.pics${direct}"`));
            assert.ok(page.text.includes('noindex'));
            assert.ok(page.text.includes(`content="https://openvibe.pics${direct}"`), 'og:image is the picture');
            assert.ok(page.text.includes('Report this picture'));
            assert.ok(!page.text.includes('Delete this picture'), 'no owner tools for a visitor');
            assert.ok((await t.get(`/i/${slug}`, { headers: PICS, as: kim })).text.includes('Delete this picture'));
        });

        await check('resize and convert: ladder widths up to the picture\'s own, in WebP, AVIF, JPEG or PNG', async () => {
            const page = await t.get(`/i/${slug}`, { headers: PICS });
            assert.ok(page.text.includes('Resize and convert') && page.text.includes(`href="/i/${slug}/w/640.webp"`));
            assert.ok(!page.text.includes(`/i/${slug}/w/1280.`), 'never wider than the picture (800 px)');
            const webp = await t.get(`/i/${slug}/w/320.webp`, { headers: PICS });
            assert.strictEqual(webp.status, 200);
            assert.strictEqual(webp.headers.get('content-type'), 'image/webp');
            assert.strictEqual(webp.headers.get('cache-control'), 'public, max-age=600, s-maxage=600');
            const meta = await sharp(webp.buffer).metadata();
            assert.deepStrictEqual([meta.format, meta.width], ['webp', 320]);
            const png = await t.get(`/i/${slug}/w/640.png`, { headers: PICS });
            assert.deepStrictEqual([png.status, (await sharp(png.buffer).metadata()).format], [200, 'png']);
            assert.strictEqual((await t.get(`/i/${slug}/w/1280.webp`, { headers: PICS })).status, 400, 'wider than the picture');
            assert.strictEqual((await t.get(`/i/${slug}/w/500.webp`, { headers: PICS })).status, 400, 'off the ladder');
        });

        await check('the plain form uploads without JavaScript; a write from another site is refused', async () => {
            const png = await photo('#a3c').png().toBuffer();
            const form = multipart({ title: 'From the form' }, { name: 'pink.png', type: 'image/png', buffer: png });
            const r = await t.get('/upload', { as: kim, method: 'POST', body: form.body, headers: { ...SAME, 'content-type': form.type } });
            assert.strictEqual(r.status, 303, r.text.slice(0, 300));
            assert.match(r.headers.get('location'), /^\/i\/[2-9a-km-zA-HJ-NP-Z]{8}\?new=1$/);
            const cross = await t.get('/upload', { as: kim, method: 'POST', body: form.body, headers: { ...PICS, 'sec-fetch-site': 'cross-site', 'content-type': form.type } });
            assert.strictEqual(cross.status, 403);
            const crossApi = await t.get('/api/v1/images', { as: kim, method: 'POST', body: png, headers: { ...PICS, 'sec-fetch-site': 'cross-site', 'content-type': 'image/png' } });
            assert.strictEqual(crossApi.json().code, 'request.cross_site');
        });

        await check('only the uploader changes or deletes a picture', async () => {
            assert.strictEqual((await t.get(`/api/v1/images/${slug}`, { as: lee, method: 'PATCH', json: { title: 'mine now' }, headers: SAME })).status, 403);
            assert.strictEqual((await t.get(`/api/v1/images/${slug}`, { as: lee, method: 'DELETE', headers: SAME })).status, 403);
            const ok = await t.get(`/api/v1/images/${slug}`, { as: kim, method: 'PATCH', json: { title: 'The coast at dusk' }, headers: SAME });
            assert.strictEqual(ok.json().title, 'The coast at dusk');
            const extra = (await up(kim, await photo('#060').jpeg().toBuffer())).json();
            const before = t.media.deleted.length;
            assert.strictEqual((await t.get(`/api/v1/images/${extra.slug}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204);
            assert.strictEqual(t.media.deleted.length - before, 2, 'the picture and its thumbnail are deleted in Media');
            assert.strictEqual((await t.get(`/i/${extra.slug}.jpg`, { headers: PICS })).status, 404);
        });

        await check('three reports hide a picture: 404 for everyone but its uploader and staff', async () => {
            const pic = (await up(kim, await photo('#909').jpeg().toBuffer(), { title: 'Reported' })).json();
            const report = (as, extra = {}) => t.get(`/api/v1/images/${pic.slug}/reports`, { as, json: { reason: 'spam' }, headers: { ...SAME, ...extra } });
            assert.strictEqual((await report(lee)).status, 201);
            assert.strictEqual((await report(lee)).json().already, true, 'one report per person');
            assert.strictEqual((await report(ana)).json().hidden, false);
            const third = await report(null, { 'x-forwarded-for': '203.0.113.7' });
            assert.strictEqual(third.json().hidden, true, 'a signed-out reporter counts by address');
            assert.strictEqual((await t.get(`/i/${pic.slug}.jpg`, { headers: PICS })).status, 404);
            assert.strictEqual((await t.get(`/i/${pic.slug}`, { headers: PICS })).status, 404);
            const own = await t.get(`/i/${pic.slug}`, { headers: PICS, as: kim });
            assert.ok(own.status === 200 && own.text.includes('hidden while staff look'));
            const staffView = await t.get(`/i/${pic.slug}.jpg`, { headers: PICS, as: boss });
            assert.strictEqual(staffView.status, 200, 'staff can see what they review');
            assert.strictEqual(staffView.headers.get('cache-control'), 'private, no-store');
            assert.ok((await t.get('/staff', { headers: PICS, as: boss })).text.includes('Reported'));
            assert.strictEqual((await t.get('/staff', { headers: PICS, as: lee })).status, 404, 'the queue is staff only');
            assert.strictEqual((await t.get(`/staff/i/${pic.slug}`, { headers: SAME, as: boss, form: { action: 'restore' } })).status, 303);
            assert.strictEqual((await t.get(`/i/${pic.slug}.jpg`, { headers: PICS })).status, 200, 'restored');
        });

        await check('a child-safety report hides at once; a takedown deletes it and blocks the same picture and near-copies', async () => {
            const original = await photo('#c22', 1000, 1000).jpeg({ quality: 90 }).toBuffer();
            const pic = (await up(lee, original, { title: 'Bad' })).json();
            const r = await t.get(`/api/v1/images/${pic.slug}/reports`, { as: ana, json: { reason: 'child_safety', note: 'please look' }, headers: SAME });
            assert.strictEqual(r.json().hidden, true);
            const before = t.media.deleted.length;
            assert.strictEqual((await t.get(`/staff/i/${pic.slug}`, { headers: SAME, as: boss, form: { action: 'takedown', reason: 'csam' } })).status, 303);
            assert.strictEqual(t.media.deleted.length - before, 2, 'the bytes are deleted');
            assert.strictEqual((await t.get(`/i/${pic.slug}`, { headers: PICS })).status, 410);
            assert.strictEqual((await t.get(`/i/${pic.slug}.jpg`, { headers: PICS })).status, 410);
            assert.strictEqual((await up(kim, original)).json().code, 'pics.blocked', 'the same file');
            const resized = await sharp(original).resize(700).webp({ quality: 70 }).toBuffer();
            assert.strictEqual((await up(kim, resized, { type: 'image/webp' })).json().code, 'pics.blocked', 'a resized, re-compressed copy');
            assert.strictEqual((await up(kim, await sharp(original).flop().jpeg().toBuffer())).status, 201, 'a different picture is fine');
        });

        await check('albums: made by a person, shown to anyone with the link, only the owner adds and removes', async () => {
            const made = await t.get('/api/v1/albums', { as: kim, json: { title: 'Holiday' }, headers: SAME });
            assert.strictEqual(made.status, 201);
            const album = made.json();
            assert.strictEqual((await t.get(`/api/v1/albums/${album.slug}/images`, { as: kim, json: { image: slug }, headers: SAME })).status, 204);
            const leePic = (await up(lee, await photo('#077').jpeg().toBuffer())).json();
            assert.strictEqual((await t.get(`/api/v1/albums/${album.slug}/images`, { as: kim, json: { image: leePic.slug }, headers: SAME })).status, 422, 'not your picture');
            assert.strictEqual((await t.get(`/api/v1/albums/${album.slug}/images`, { as: lee, json: { image: leePic.slug }, headers: SAME })).status, 404, 'not your album');
            const view = await t.get(`/a/${album.slug}`, { headers: PICS });
            assert.ok(view.status === 200 && view.text.includes('Holiday') && view.text.includes(`/i/${slug}/thumb.webp`));
            assert.strictEqual((await t.get(`/api/v1/albums/${album.slug}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204);
            assert.strictEqual((await t.get(`/i/${slug}`, { headers: PICS })).status, 200, 'the pictures stay');
        });

        await check('your pictures and the API list: newest first, with your usage', async () => {
            const r = await t.get('/api/v1/me/images', { as: kim, headers: PICS });
            assert.ok(r.json().images.length >= 2 && r.json().usage.images >= 2);
            assert.strictEqual((await t.get('/mine', { headers: PICS })).status, 401);
            assert.ok((await t.get('/mine', { headers: PICS, as: kim })).text.includes('The coast at dusk'));
        });
    } finally { await t0.close(); }

    // ── Signed-out uploads, when the owner turns them on ──
    let clock = Date.parse('2026-10-15T12:00:00Z');
    const t20 = await boot({ env: { MEDIAHUB_PICS_ANONYMOUS: '1', MEDIAHUB_PICS_ANONYMOUS_PER_DAY: '2' }, now: () => clock });
    const t2 = { ...t20, get: hostClient(t20) };
    try {
        await check('signed out (when on): a delete key shown once, kept as a hash, a daily limit, and the idle sweep', async () => {
            const anon = (buf) => t2.get('/api/v1/images', { method: 'POST', body: buf, headers: { ...SAME, 'content-type': 'image/jpeg', 'x-forwarded-for': '198.51.100.4' } });
            const r = await anon(await photo('#246').jpeg().toBuffer());
            assert.strictEqual(r.status, 201, r.text);
            const b = r.json();
            assert.ok(b.delete_key && b.delete_url.includes(b.delete_key));
            assert.ok(!(await t2.dbDump()).includes(b.delete_key), 'only the key\'s hash is stored');
            assert.strictEqual((await t2.get(`/api/v1/images/${b.slug}`, { method: 'DELETE', headers: { ...SAME, 'x-delete-key': 'wrong' } })).status, 403);
            const page = await t2.get(`/i/${b.slug}/delete?key=${b.delete_key}`, { headers: PICS });
            assert.ok(page.status === 200 && page.text.includes('Delete it for good'), 'the delete link is a page; a GET never deletes');
            assert.strictEqual((await t2.get(`/api/v1/images/${b.slug}`, { method: 'DELETE', headers: { ...SAME, 'x-delete-key': b.delete_key } })).status, 204);

            const kept = (await anon(await photo('#642').jpeg().toBuffer())).json();
            assert.strictEqual((await anon(await photo('#426').jpeg().toBuffer())).json().code, 'pics.daily_limit');
            clock += 31 * 86_400_000;
            assert.strictEqual(await t2.ctx.pics.sweep(), 1, 'a signed-out picture nobody viewed for 30 days goes');
            assert.strictEqual((await t2.get(`/i/${kept.slug}`, { headers: PICS })).status, 404);
        });
    } finally { await t20.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
