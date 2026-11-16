'use strict';

/**
 * What happens to a picture before anyone sees it (sharp, libvips):
 *
 *   - It must decode as JPEG, PNG, GIF, WebP, AVIF or (2026-11-16, the owner: "Media should support svg and all
 *     other file formats") SVG, within MEDIAHUB_PICS_MAX_PIXELS. Anything else (a script renamed .png, a truncated or
 *     malformed file) is refused. A raster picture is never served as it was uploaded.
 *   - An SVG is a drawing: kept as drawn (it has no camera metadata to drop), at most SVG_MAX_BYTES, and served only
 *     under the sandbox policy (pages.js, Media), where a script in it never runs. Its thumbnail and difference hash
 *     are drawn to pixels from its bytes, never a path, so it cannot pull in another file.
 *   - It is re-encoded in its own format: the orientation is applied, and every metadata block (EXIF with its GPS
 *     position and camera serial, XMP, IPTC, comments) is dropped. An animated GIF or WebP keeps its frames.
 *     A colour profile is converted to sRGB rather than kept.
 *   - A 640-pixel WebP thumbnail is made (the first frame of an animation).
 *   - Three hashes: sha256 of what was uploaded and of what is served, and a 64-bit difference hash (dHash) of a
 *     9×8 greyscale copy, which stays close for a resized, re-compressed or lightly edited copy of the same picture.
 *     The takedown blocklist matches on all three (server/pics/service.js).
 *
 * prepare(buffer) → { ok: true, image: { buffer, mime, ext, width, height, animated }, thumb: { buffer, mime,
 * width, height }, sha256, sourceSha256, dhash } or { ok: false, code, detail }.
 */
const crypto = require('crypto');
const sharp = require('sharp');

// libvips caches decoded images; this process serves pages too, so keep its memory small and its threads few.
sharp.cache({ memory: 64, files: 0, items: 50 });
sharp.concurrency(2);

const FORMATS = {
    jpeg: { mime: 'image/jpeg', ext: 'jpg' },
    png: { mime: 'image/png', ext: 'png' },
    gif: { mime: 'image/gif', ext: 'gif' },
    webp: { mime: 'image/webp', ext: 'webp' },
    heif: { mime: 'image/avif', ext: 'avif' },   // sharp reports AVIF as heif; only the AV1 kind decodes
};
const SVG = { mime: 'image/svg+xml', ext: 'svg' };
const SVG_MAX_BYTES = 5 * 1024 * 1024;
const EXTS = [...Object.values(FORMATS).map((f) => f.ext), SVG.ext];
const THUMB = 640;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** The 64-bit difference hash of a picture's first frame, as 16 hex digits. */
async function dhashOf(input) {
    const px = await sharp(input, { pages: 1, failOn: 'error' }).rotate().grayscale().resize(9, 8, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
        // A margin of 2 levels: in a flat area two neighbours differ by compression noise only, and a bare `>` would
        // flip with every re-encode.
        for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x] - px[y * 9 + x + 1] > 2 ? 1n : 0n);
    }
    return bits.toString(16).padStart(16, '0');
}

/** How many of the 64 bits two difference hashes disagree on. */
function distance(a, b) {
    let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
    let n = 0;
    while (x) { n += Number(x & 1n); x >>= 1n; }
    return n;
}

async function prepare(input, { maxPixels = 100_000_000 } = {}) {
    if (!Buffer.isBuffer(input) || input.length < 16) return { ok: false, code: 'pics.not_an_image', detail: 'That file is not a picture we can show.' };
    let meta;
    try {
        meta = await sharp(input, { limitInputPixels: maxPixels, failOn: 'error', animated: true }).metadata();
    } catch (err) {
        const tooBig = /pixel limit/i.test(String(err && err.message));
        return tooBig
            ? { ok: false, code: 'pics.too_many_pixels', detail: `That picture has more than ${Number((maxPixels / 1e6).toPrecision(3))} megapixels.` }
            : { ok: false, code: 'pics.not_an_image', detail: 'That file is not a JPEG, PNG, GIF, WebP, AVIF or SVG picture we can read.' };
    }
    if (meta.format === 'svg') return prepareSvg(input, meta, { maxPixels });
    const format = FORMATS[meta.format];
    if (!format || (meta.format === 'heif' && meta.compression !== 'av1')) {
        return { ok: false, code: 'pics.unsupported', detail: 'Pictures can be JPEG, PNG, GIF, WebP, AVIF or SVG.' };
    }
    const pages = Number(meta.pages) || 1;
    const animated = pages > 1 && (meta.format === 'gif' || meta.format === 'webp');
    try {
        // .rotate() with no angle applies the EXIF orientation; libvips drops all metadata on output unless asked.
        let pipe = sharp(input, { limitInputPixels: maxPixels, failOn: 'error', animated });
        if (!animated) pipe = pipe.rotate();
        pipe = pipe.toColourspace('srgb');
        if (meta.format === 'jpeg') pipe = pipe.jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:2:0' });
        else if (meta.format === 'png') pipe = pipe.png({ compressionLevel: 9, adaptiveFiltering: true });
        else if (meta.format === 'gif') pipe = pipe.gif({ effort: 7 });
        else if (meta.format === 'webp') pipe = pipe.webp({ quality: 90, effort: 4 });
        else pipe = pipe.avif({ quality: 62, effort: 4 });
        const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
        const height = animated ? Math.round(info.height / (info.pages || pages)) : info.height;

        const thumb = await sharp(data, { pages: 1, failOn: 'error' })
            .resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 76, effort: 4 })
            .toBuffer({ resolveWithObject: true });

        return {
            ok: true,
            image: { buffer: data, mime: format.mime, ext: format.ext, width: info.width, height, animated },
            thumb: { buffer: thumb.data, mime: 'image/webp', width: thumb.info.width, height: thumb.info.height },
            sha256: sha256(data),
            sourceSha256: sha256(input),
            dhash: await dhashOf(data),
        };
    } catch {
        return { ok: false, code: 'pics.not_an_image', detail: 'That picture could not be read to the end. Is the file complete?' };
    }
}

/** An SVG: kept as drawn; its thumbnail and hash drawn to pixels from its bytes (density for a sharp 640 px). */
async function prepareSvg(input, meta, { maxPixels }) {
    if (input.length > SVG_MAX_BYTES) return { ok: false, code: 'pics.too_large', detail: `A drawing can be at most ${SVG_MAX_BYTES / 1024 / 1024} MB.` };
    try {
        const w = Number(meta.width) || 0, h = Number(meta.height) || 0;
        const density = Math.min(1200, Math.max(72, Math.ceil(72 * THUMB / Math.max(1, w, h))));
        const raster = await sharp(input, { density, limitInputPixels: maxPixels, failOn: 'error' }).png().toBuffer({ resolveWithObject: true });
        const thumb = await sharp(raster.data, { failOn: 'error' })
            .resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 76, effort: 4 })
            .toBuffer({ resolveWithObject: true });
        return {
            ok: true,
            image: { buffer: input, mime: SVG.mime, ext: SVG.ext, width: w || raster.info.width, height: h || raster.info.height, animated: false },
            thumb: { buffer: thumb.data, mime: 'image/webp', width: thumb.info.width, height: thumb.info.height },
            sha256: sha256(input),
            sourceSha256: sha256(input),
            dhash: await dhashOf(raster.data),
        };
    } catch {
        return { ok: false, code: 'pics.not_an_image', detail: 'That drawing could not be read. Is the SVG complete?' };
    }
}

module.exports = { prepare, dhashOf, distance, sha256, EXTS, FORMATS, THUMB, SVG, SVG_MAX_BYTES };
