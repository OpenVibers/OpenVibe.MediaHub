'use strict';
/**
 * Resize and convert (the owner's "image processing" for OpenVibe.Pics): a picture at a width on a fixed ladder and in
 * another format, made here with sharp from the stored (already re-encoded) picture. OpenVibe.Media's own variants stop
 * at 640 px, so the larger sizes are this service's.
 *
 *   GET /i/<slug>/w/<width>.<webp|avif|jpg|png>     width: 320, 640, 1280, 1920 or 2560 (never wider than the picture)
 *
 * A made variant is kept in a small in-process LRU (MEDIAHUB_PICS_VARIANT_CACHE_BYTES, 64 MB) and served with the direct
 * link's 10-minute public cache, so a burst of the same variant is made once. An animated picture keeps its frames as
 * WebP; the other formats get its first frame.
 */
const LADDER = [320, 640, 1280, 1920, 2560];
const FORMATS = Object.freeze({
    webp: { type: 'image/webp', apply: (img) => img.webp({ quality: 80 }) },
    avif: { type: 'image/avif', apply: (img) => img.avif({ quality: 55, effort: 3 }) },
    jpg: { type: 'image/jpeg', apply: (img) => img.jpeg({ quality: 85, mozjpeg: true }) },
    png: { type: 'image/png', apply: (img) => img.png({ compressionLevel: 8 }) },
});

function createPicVariants({ media, sharp = require('sharp'), maxBytes = 64 * 1024 * 1024, maxSourceBytes = 40 * 1024 * 1024 }) {
    const cache = new Map();   // key → { type, buffer } in least-recently-used order
    let held = 0;
    const inflight = new Map();

    const remember = (key, v) => {
        if (v.buffer.length > maxBytes / 4) return;
        cache.set(key, v);
        held += v.buffer.length;
        for (const [k, old] of cache) {
            if (held <= maxBytes) break;
            cache.delete(k);
            held -= old.buffer.length;
        }
    };

    /** The widths this picture can be had at (the ladder up to its own width). */
    const widthsFor = (row) => LADDER.filter((w) => w <= Number(row.width));

    async function make(row, w, fmt) {
        const got = await media.bytes(row.object_id);
        if (!got.ok) return { status: got.status === 404 || got.status === 410 ? 404 : 502 };
        const source = Buffer.from(await got.res.arrayBuffer());
        if (source.length > maxSourceBytes) return { status: 413 };
        const animated = Boolean(row.animated) && fmt === 'webp';
        const img = sharp(source, { animated, failOn: 'error', limitInputPixels: 100_000_000 })
            .resize({ width: w, withoutEnlargement: true });
        const buffer = await FORMATS[fmt].apply(img).toBuffer();
        return { status: 200, type: FORMATS[fmt].type, buffer };
    }

    /** → { status, type, buffer } for an active picture; 400 for a width or format off the ladder. */
    async function get(row, w, fmt) {
        if (!FORMATS[fmt] || !LADDER.includes(w) || w > Number(row.width)) return { status: 400 };
        const key = `${row.id}:${w}:${fmt}`;
        const hit = cache.get(key);
        if (hit) {
            cache.delete(key);
            cache.set(key, hit);
            return { status: 200, ...hit };
        }
        if (inflight.has(key)) return inflight.get(key);
        const p = make(row, w, fmt).then((v) => {
            if (v.status === 200) remember(key, { type: v.type, buffer: v.buffer });
            return v;
        }).finally(() => inflight.delete(key));
        inflight.set(key, p);
        return p;
    }

    return { get, widthsFor, LADDER, FORMATS: Object.keys(FORMATS), stats: () => ({ entries: cache.size, bytes: held }) };
}

module.exports = { createPicVariants, LADDER };
