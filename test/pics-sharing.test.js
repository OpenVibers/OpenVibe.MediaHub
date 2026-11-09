'use strict';
/**
 * Sharing on MediaHub pictures and albums (design 2026-11-06, VISIBILITY-EVERYWHERE step 4;
 * openvibe-sdk/share). Unlisted by default (publishing is explicit),
 * Only me and Specific people narrow it; the share row decides the page, the file, the thumbnail
 * and an album, and the gate never shows the picture.
 */
const assert = require('assert');
const http = require('http');
const sharp = require('sharp');
const { boot, check, done } = require('./helpers/boot');
const picsStore = require('../server/pics/store');

function hostClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const headers = { Host: 'openvibe.pics', ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = o.body;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (body != null) headers['content-length'] = String(Buffer.byteLength(body));
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body != null ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buffer: buf, json() { return JSON.parse(buf.toString('utf8')); } }); });
        });
        req.on('error', reject);
        if (body != null) req.write(body);
        req.end();
    });
}

(async () => {
    const t = await boot();
    const get = hostClient(t);
    const kate = t.network.addUser('kate');
    const mate = t.network.addUser('milo');
    const sam = t.network.addUser('sam');
    let seq = 0;
    const upload = async () => {
        // Different bytes each time: identical bytes dedupe to the same picture (and its audience).
        seq += 1;
        const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: seq, g: (seq * 7) % 256, b: 99 } } }).png().toBuffer();
        const out = await t.ctx.pics.upload({ requester: `user:${kate.subject}` }, { buffer: png, name: 'a.png' }, { title: 'Secret picture' });
        assert.strictEqual(out.ok, true, JSON.stringify(out));
        return out.image;
    };
    const share = (kind, id, o = {}) => get(`/api/v1/${kind}/${id}/share`, { headers: { 'x-requested-with': 'ov-share' }, ...o });
    const putShare = (kind, id, body) => share(kind, id, { method: 'PUT', as: kate, json: body });
    const row = async (id) => await t.ctx.s.db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['mediahub', 'picture', id]);

    await check('a new picture is registered for anyone with the link, owned by its uploader', async () => {
        const img = await upload();
        const s = await row(img.id);
        assert.strictEqual(s.audience, 'link');
        assert.deepStrictEqual(s.owner_subject, { type: 'user', id: kate.subject });
        assert.strictEqual((await get(`/i/${img.slug}`)).status, 200);
        assert.strictEqual((await get(`/i/${img.slug}.png`)).status, 200);
    });

    await check('Only me: the page, the file and the thumbnail never answer anyone else', async () => {
        const img = await upload();
        const put = await putShare('picture', img.id, { audience: 'private' });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual((await get(`/i/${img.slug}`, { as: sam })).status, 404);
        assert.strictEqual((await get(`/i/${img.slug}.png`, { as: sam })).status, 404);
        assert.strictEqual((await get(`/i/${img.slug}/thumb.webp`, { as: sam })).status, 404);
        assert.strictEqual((await get(`/i/${img.slug}`, { as: kate })).status, 200);
    });

    await check('Specific people: the named person opens the picture; a stranger gets the gate and no image', async () => {
        const img = await upload();
        const put = await putShare('picture', img.id, { audience: 'people', members: [{ subject: { type: 'user', id: mate.subject }, role: 'viewer' }] });
        assert.strictEqual(put.status, 200, put.text);
        assert.strictEqual((await get(`/i/${img.slug}`, { as: mate })).status, 200);
        assert.strictEqual((await get(`/i/${img.slug}.png`, { as: mate })).status, 200);
        const stranger = await get(`/i/${img.slug}`, { as: sam });
        assert.strictEqual(stranger.status, 404);
        assert.ok(stranger.text.includes('shared with specific people') && stranger.text.includes('data-ov-share-gate'));
        assert.ok(!stranger.text.includes('Secret picture'), 'no title');
        assert.strictEqual((await get(`/i/${img.slug}.png`, { as: sam })).status, 404);
        assert.strictEqual((await share('picture', img.id, { as: sam })).status, 404, 'the sheet is the owner’s');
    });

    await check('an album has its own audience; Only me hides it from everyone else', async () => {
        const made = await t.ctx.pics.createAlbum(`user:${kate.subject}`, { title: 'Private album' });
        assert.strictEqual(made.ok, true, JSON.stringify(made));
        const album = made.album;
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['mediahub', 'album', album.id])).audience, 'public');
        assert.strictEqual((await get(`/a/${album.slug}`)).status, 200);
        assert.strictEqual((await putShare('album', album.id, { audience: 'private' })).status, 200);
        assert.strictEqual((await get(`/a/${album.slug}`, { as: sam })).status, 404);
        assert.strictEqual((await get(`/a/${album.slug}`, { as: kate })).status, 200);
    });


    await check('a narrowed picture leaves shared caches at once: private, no-store; Everyone keeps s-maxage=60', async () => {
        const img = await upload();
        const pub = await get(`/i/${img.slug}.png`);
        assert.strictEqual(pub.status, 200);
        assert.match(pub.headers['cache-control'], /^public/);
        assert.match(pub.headers['cache-control'], /s-maxage=60/);
        await putShare('picture', img.id, { audience: 'private' });
        const owner = await get(`/i/${img.slug}.png`, { as: kate });
        assert.strictEqual(owner.status, 200);
        assert.strictEqual(owner.headers['cache-control'], 'private, no-store');
        assert.strictEqual((await get(`/i/${img.slug}.png`)).status, 404);
        const thumb = await get(`/i/${img.slug}/thumb.webp`, { as: kate });
        if (thumb.status === 200) assert.strictEqual(thumb.headers['cache-control'], 'private, no-store');
    });

    await check('Only me leaves the album page, and an album carries its pictures', async () => {
        const img = await upload();
        const made = await t.ctx.pics.createAlbum(`user:${kate.subject}`, { title: 'A folder' });
        assert.strictEqual(made.ok, true, JSON.stringify(made));
        const album = made.album;
        const imageRow = await picsStore.imageBySlug(t.ctx.s, img.slug);
        const albumRow = await picsStore.albumBySlug(t.ctx.s, album.slug);
        await t.ctx.pics.addToAlbum(albumRow, imageRow);
        const open = await get(`/a/${album.slug}`);
        assert.strictEqual(open.status, 200);
        assert.ok(open.text.includes(`/i/${img.slug}.png`), 'the picture is in the album');
        await putShare('picture', img.id, { audience: 'private' });
        const hidden = await get(`/a/${album.slug}`);
        assert.strictEqual(hidden.status, 200);
        assert.ok(!hidden.text.includes(`/i/${img.slug}.png`), 'Only me is not in the album page');
        assert.strictEqual((await get(`/i/${img.slug}.png`, { as: kate })).status, 200);
        // The album's own audience carries its pictures.
        assert.strictEqual((await putShare('album', album.id, { audience: 'private' })).status, 200);
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT audience FROM pics_images WHERE id = $1', [img.id])).audience, 'private');
        assert.strictEqual((await t.ctx.s.db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', ['mediahub', 'picture', img.id])).audience, 'private');
    });

    await done();
    await t.close();
})();
