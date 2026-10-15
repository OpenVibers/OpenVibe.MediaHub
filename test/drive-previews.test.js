'use strict';
/**
 * Previews: an image in the drive shows a small picture of itself in the list and a larger one on its page, made by
 * OpenVibe.Media as a signed variant of the private object (GET /o/:id?…&w=&fmt=webp) and passed through MediaHub.
 * Only the file's owner (or, for a single-file share, whoever may open the share) gets one; other files get their
 * type instead; a preview is private to the browser, never an attachment, never a download.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { bytes, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const lee = t.network.addUser('lee');
    const put = async (name, data, contentType) => (await upload(t, kim, data, { name, contentType })).json().file;
    const photo = await put('holiday.png', bytes(256, 'png'), 'image/png');
    const notes = await put('notes.txt', bytes(64, 'txt'), 'text/plain');
    const vector = await put('logo.svg', bytes(64, 'svg'), 'image/svg+xml');

    await check('the list shows a picture of each image and the type of everything else', async () => {
        const page = await t.get('/files', { as: kim });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes(`<img class="file-thumb" src="/files/${photo.id}/preview?w=96" alt="" width="48" height="48" loading="lazy" decoding="async">`));
        assert.match(page.text, /<span class="file-thumb file-thumb-type" aria-hidden="true">TXT<\/span>/);
        assert.match(page.text, /<span class="file-thumb file-thumb-type" aria-hidden="true">SVG<\/span>/, 'an SVG is never rendered: its type, not a picture');
        const one = await t.get(`/files/${photo.id}`, { as: kim });
        assert.ok(one.text.includes(`<figure class="file-preview"><img src="/files/${photo.id}/preview?w=640" alt="holiday.png" decoding="async"></figure>`));
        assert.ok(!(await t.get(`/files/${notes.id}`, { as: kim })).text.includes('file-preview'));
    });

    await check('a preview is Media\'s signed WebP variant, private to the browser and never an attachment', async () => {
        const before = t.media.requests.length;
        const r = await t.get(`/files/${photo.id}/preview?w=96`, { as: kim });
        assert.strictEqual(r.status, 200, r.text);
        assert.deepStrictEqual([r.headers.get('content-type'), r.headers.get('cache-control'), r.headers.get('x-content-type-options'), r.headers.get('content-disposition')], ['image/webp', 'private, max-age=300', 'nosniff', null]);
        assert.match(r.buffer.toString(), /^variant:96:webp:/);
        const asked = t.media.requests.slice(before).find((q) => q.path.startsWith('/o/'));
        assert.match(asked.query, /[?&]exp=\d+&sig=[^&]+&w=96&fmt=webp$/, 'signed, then the size and the format');
        const big = await t.get(`/files/${photo.id}/preview?w=640`, { as: kim });
        assert.match(big.buffer.toString(), /^variant:640:webp:/);
        const odd = await t.get(`/files/${photo.id}/preview?w=1234`, { as: kim });
        assert.match(odd.buffer.toString(), /^variant:96:webp:/, 'only the two sizes the pages use');
    });

    await check('no preview for other people\'s files, for files that are not images, or for SVG', async () => {
        assert.strictEqual((await t.get(`/files/${photo.id}/preview?w=96`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/files/${notes.id}/preview?w=96`, { as: kim })).status, 404);
        assert.strictEqual((await t.get(`/files/${vector.id}/preview?w=96`, { as: kim })).status, 404);
        const anon = await t.get(`/files/${photo.id}/preview?w=96`);
        assert.ok([302, 303, 401].includes(anon.status), `signed out: ${anon.status}`);
    });

    await check('a single-file share shows its picture to whoever may open it; it is not a download', async () => {
        const slug = (await share(t, kim, { file_id: photo.id, hours: 24, usernames: ['sam'] })).json().share.slug;
        const page = await t.get(`/s/${slug}`, { as: sam });
        assert.ok(page.text.includes(`<figure class="file-preview"><img src="/s/${slug}/preview?w=640" alt="holiday.png" decoding="async"></figure>`));
        const pv = await t.get(`/s/${slug}/preview?w=640`, { as: sam });
        assert.deepStrictEqual([pv.status, pv.headers.get('content-type')], [200, 'image/webp']);
        assert.strictEqual((await t.get(`/s/${slug}/preview?w=640`, { as: lee })).status, 403, 'not shared with lee');
        const shares = (await t.get(`/api/v1/files/${photo.id}`, { as: kim })).json().shares;
        assert.strictEqual(shares.find((x) => x.slug === slug).downloads, 0, 'looking is not downloading');
    });

    done();
})();
