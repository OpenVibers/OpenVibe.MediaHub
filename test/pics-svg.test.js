'use strict';
// SVG on openvibe.pics (2026-11-16; the owner: "Media should support svg and all other file formats and also .download
// and all files"): a drawing is a picture, kept as drawn, with a WebP thumbnail and a difference hash drawn from its
// bytes; a drawing too big, or not a drawing at all, is refused in plain words.
const assert = require('assert');
const images = require('../server/pics/images');

(async () => {
    const badge = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128"><rect width="128" height="128" rx="28" fill="#7c3aed"/><circle cx="64" cy="64" r="36" fill="#fcd34d" stroke="#0f172a" stroke-width="4"/></svg>');
    const got = await images.prepare(badge);
    assert.strictEqual(got.ok, true, JSON.stringify(got));
    assert.deepStrictEqual([got.image.mime, got.image.ext, got.image.width, got.image.height], ['image/svg+xml', 'svg', 128, 128]);
    assert.ok(got.image.buffer.equals(badge), 'kept as drawn');
    assert.strictEqual(got.thumb.mime, 'image/webp');
    assert.ok(got.thumb.width > 128 && got.thumb.width <= images.THUMB, `the thumbnail is drawn sharp, not 128 px stretched (${got.thumb.width})`);
    assert.match(got.dhash, /^[0-9a-f]{16}$/);
    assert.strictEqual(got.sha256, got.sourceSha256);
    assert.ok(images.EXTS.includes('svg'));

    const same = await images.prepare(Buffer.from(badge.toString().replace('#7c3aed', '#7c3aee')));
    assert.ok(images.distance(got.dhash, same.dhash) <= 4, 'a near copy hashes near (the takedown list matches it)');

    const big = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="9" height="9"><!-- ${'x'.repeat(images.SVG_MAX_BYTES)} --><rect width="9" height="9"/></svg>`);
    assert.strictEqual((await images.prepare(big)).code, 'pics.too_large');
    assert.strictEqual((await images.prepare(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="9"'))).ok, false, 'a broken drawing is refused');
    console.log('pics-svg: a drawing is a picture, kept as drawn, with its thumbnail and hash drawn from its bytes');
})().catch((e) => { console.error(e); process.exit(1); });
