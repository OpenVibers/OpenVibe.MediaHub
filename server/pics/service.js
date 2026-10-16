'use strict';

/**
 * OpenVibe.Pics: the rules. The pages (server/pics/pages.js) and the API (server/pics/api.js) both come through here,
 * so a form and an API call can never mean different things.
 *
 *   upload       a picture from a person (or signed out, when MEDIAHUB_PICS_ANONYMOUS=1): size, daily count and
 *                quota checks, then images.prepare() (decode, re-encode without metadata, thumbnail, hashes), then
 *                the blocklist, then two private Media objects and the row. A signed-out upload gets a delete key,
 *                shown once and kept only as its sha256.
 *   report       one per reporter per picture. `child_safety` hides the picture at once; any other reason hides it
 *                at MEDIAHUB_PICS_REPORTS_TO_HIDE distinct reports. Hidden is 404 for everyone but its uploader and
 *                staff, until staff decide. The bytes are private Media objects that only this service reads and serves
 *                (server/pics/pages.js /i/<slug>.<ext>), so hiding a picture stops it everywhere at once, apart from
 *                what a cache already holds for its last few minutes.
 *   takedown     staff: the picture is removed, its Media objects deleted, and its hashes go on the blocklist so the
 *                same picture (or a near-duplicate) cannot be uploaded again.
 *   remove       the uploader (or a signed-out uploader with the delete key) deletes it, bytes and all.
 *   sweep        signed-out pictures nobody has viewed for MEDIAHUB_PICS_ANONYMOUS_IDLE_DAYS are deleted.
 *
 * Who may see a picture: active ones, anyone with the link; hidden ones, the uploader and staff; removed ones, staff.
 */
const crypto = require('crypto');
const images = require('./images');
const store = require('./store');
const { isStaff } = require('../drive/staff');

const SLUG_ALPHABET = '23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const SLUG_RE = /^[2-9a-km-zA-HJ-NP-Z]{8}$/;
const REASONS = ['child_safety', 'illegal', 'copyright', 'sexual', 'violence', 'harassment', 'private_info', 'spam', 'other'];
const REASON_TEXT = {
    child_safety: 'Child sexual abuse or exploitation', illegal: 'Other illegal content', copyright: 'Copyright infringement (see the DMCA page)',
    sexual: 'Sexual content shared without consent', violence: 'Graphic violence or threats', harassment: 'Harassment or hate',
    private_info: 'Someone\'s private information', spam: 'Spam or a scam', other: 'Something else',
};
const LIMITS = { title: 120, description: 2000, alt: 160, albumTitle: 120, note: 500 };
// A difference hash this close (of 64 bits) to a blocked one is the same picture, resized, re-compressed or retouched:
// measured 2026-10-15, such copies of real photos land 0-10 bits away and different photos 23-42.
const DHASH_DISTANCE = 10;

const slug = () => Array.from(crypto.randomBytes(8), (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join('');
const cleanLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
/** A hash with too few or too many set bits is a near-flat picture: its dHash is noise, not an identity. */
const distinctive = (h) => { const n = images.distance(h, '0000000000000000'); return n >= 8 && n <= 56; };

function createPics({ s, media, config, log = console, events = null }) {
    const cfg = config.pics;
    const addressKey = crypto.createHash('sha256').update(`pics-address:${config.oauth.clientSecret || 'dev'}`).digest();

    /** A signed-out caller as a stable, keyed hash of their address: counted and deduplicated, never stored as is. */
    const addressId = (ip) => `ip:${crypto.createHmac('sha256', addressKey).update(String(ip || 'unknown')).digest('hex').slice(0, 32)}`;
    const day = () => s.iso().slice(0, 10);

    /** May `who` ({ requester, staff }, see whoOf in pages.js and api.js) see this picture? */
    function canSee(row, who) {
        if (!row) return false;
        if (row.state === 'active') return true;
        if (who && who.staff) return true;
        return row.state === 'hidden' && Boolean(who && who.requester && row.owner === who.requester);
    }
    const isOwner = (row, viewer) => Boolean(row && row.owner && viewer && viewer.requester && row.owner === viewer.requester);

    async function putObject(buf, { mime, name, owner, anonymous }) {
        const init = await media.init({ size: buf.length, contentType: mime, name, ownerSubject: owner, visibility: 'private', ownerless: anonymous });
        if (!init.ok) return init;
        const id = init.data && (init.data.id || (init.data.object && init.data.object.id));
        const put = await media.putContent(id, buf);
        if (!put.ok) { await media.remove(id).catch(() => {}); return put; }
        const done = await media.complete(id);
        if (!done.ok) { await media.remove(id).catch(() => {}); return done; }
        return { ok: true, id };
    }

    /** Is this picture on the takedown blocklist (exactly, or as a near-duplicate)? */
    async function blocked(prepared) {
        const exact = await store.blockedSha(s, [prepared.sha256, prepared.sourceSha256]);
        if (exact) return exact;
        if (!distinctive(prepared.dhash)) return null;
        const near = (await store.blockedDhashes(s)).find((b) => images.distance(b.value, prepared.dhash) <= DHASH_DISTANCE);
        return near || null;
    }

    /**
     * Upload one picture. who: { requester } (a person) or { anonymous: true, ip }. file: { buffer, name }.
     * → { ok, image, deleteKey? } or { ok: false, status, code, detail }.
     */
    async function upload(who, file, { title = '', description = '' } = {}) {
        const anonymous = !who || !who.requester;
        if (anonymous && !cfg.anonymous) return { ok: false, status: 401, code: 'pics.sign_in_required', detail: 'Sign in with OpenVibe to upload pictures.' };
        const buf = file && file.buffer;
        const max = anonymous ? cfg.anonymousMaxImageBytes : cfg.maxImageBytes;
        if (!buf || !buf.length) return { ok: false, status: 422, code: 'pics.empty', detail: 'Choose a picture to upload.' };
        if (buf.length > max) return { ok: false, status: 413, code: 'pics.too_large', detail: `A picture can be up to ${Math.round(max / 1024 / 1024)} MB.` };
        const uploader = anonymous ? addressId(who && who.ip) : who.requester;
        const perDay = anonymous ? cfg.anonymousPerDay : cfg.imagesPerDay;
        if (await store.uploadsToday(s, uploader, day()) >= perDay) return { ok: false, status: 429, code: 'pics.daily_limit', detail: `That is ${perDay} uploads today, the most a day. Try again tomorrow.` };
        if (!anonymous) {
            const use = await store.usageOf(s, who.requester);
            if (use.bytes + buf.length > cfg.quotaBytes) return { ok: false, status: 409, code: 'pics.quota', detail: `Your pictures would pass ${Math.round(cfg.quotaBytes / 1024 ** 3)} GB. Delete some first.` };
        }

        const prepared = await images.prepare(buf, { maxPixels: cfg.maxPixels });
        if (!prepared.ok) return { ok: false, status: 422, code: prepared.code, detail: prepared.detail };
        const hit = await blocked(prepared);
        if (hit) {
            (log.warn || log.log)(`[OpenVibe.Pics] refused an upload matching a takedown (${hit.reason})`);
            return { ok: false, status: 422, code: 'pics.blocked', detail: 'This picture was taken down from OpenVibe.Pics and cannot be uploaded again.' };
        }
        await store.countUpload(s, uploader, day());

        const id = s.newId('pic');
        const base = cleanLine(title, LIMITS.title) || cleanLine(String(file.name || '').replace(/\.[A-Za-z0-9]{1,5}$/, ''), LIMITS.title);
        const main = await putObject(prepared.image.buffer, { mime: prepared.image.mime, name: `${id}.${prepared.image.ext}`, owner: who && who.requester, anonymous });
        if (!main.ok) return { ok: false, status: 503, code: 'pics.storage', detail: 'The picture could not be stored just now. Try again in a minute.' };
        const thumb = await putObject(prepared.thumb.buffer, { mime: 'image/webp', name: `${id}-thumb.webp`, owner: who && who.requester, anonymous });
        const deleteKey = anonymous ? crypto.randomBytes(18).toString('base64url') : null;
        // The row and its mediahub.picture.uploaded event (signed-in uploads only) commit together.
        const row = await s.tx(async () => { const r = await store.insertImage(s, {
            id, slug: slug(), owner: anonymous ? null : who.requester,
            delete_key_hash: deleteKey ? images.sha256(Buffer.from(deleteKey)) : null,
            title: base, description: cleanText(description, LIMITS.description),
            object_id: main.id, thumb_object_id: thumb.ok ? thumb.id : null,
            mime_type: prepared.image.mime, ext: prepared.image.ext, width: prepared.image.width, height: prepared.image.height,
            bytes: prepared.image.buffer.length, animated: prepared.image.animated,
            sha256: prepared.sha256, source_sha256: prepared.sourceSha256, dhash: prepared.dhash, created_at: s.iso(),
        });
        if (events && !anonymous) await events.pictureUploaded(r);
        return r; });
        return { ok: true, image: row, ...(deleteKey ? { deleteKey } : {}) };
    }

    async function edit(row, { title, description, alt }) {
        // Alt text the uploader changes is theirs; an AI draft left as it was stays labelled as AI's.
        const altNow = alt !== undefined ? cleanLine(alt, LIMITS.alt) : undefined;
        const altPatch = altNow === undefined || altNow === (row.alt || '') ? {} : { alt: altNow, alt_source: altNow ? 'person' : null };
        return store.updateImage(s, row.id, {
            ...(title !== undefined ? { title: cleanLine(title, LIMITS.title) } : {}),
            ...(description !== undefined ? { description: cleanText(description, LIMITS.description) } : {}),
            ...altPatch,
        });
    }

    /** What a screen reader says for it: its alt text, else its title. */
    const altOf = (row) => row.alt || row.title || 'Picture on OpenVibe.Pics';
    const tagsOf = (row) => { try { const v = JSON.parse(row.ai_tags || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };

    const hide = (row) => store.updateImage(s, row.id, { state: 'hidden' });

    async function removeObjects(row) {
        for (const oid of [row.object_id, row.thumb_object_id].filter(Boolean)) {
            const r = await media.remove(oid);
            if (!r.ok && r.status !== 404) (log.warn || log.log)(`[OpenVibe.Pics] Media kept ${oid}: ${r.code || r.status}`);
        }
    }

    /** The uploader deletes it: the bytes in Media and the row (its reports and album places go with it). */
    async function remove(row) {
        await removeObjects(row);
        await store.deleteImage(s, row.id);
    }

    /** A signed-out upload's delete key matches? (Compared as hashes, in constant time.) */
    function deleteKeyMatches(row, key) {
        if (!row || !row.delete_key_hash || typeof key !== 'string' || !key) return false;
        const a = Buffer.from(images.sha256(Buffer.from(key)));
        const b = Buffer.from(row.delete_key_hash);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    async function report(row, { reporter, reason, note }) {
        const r = REASONS.includes(reason) ? reason : null;
        if (!r) return { ok: false, status: 422, code: 'pics.report_reason', detail: `reason: one of ${REASONS.join(', ')}` };
        const out = await store.addReport(s, row.id, { id: s.newId('prp'), reporter, reason: r, note: cleanText(note, LIMITS.note) });
        let hidden = false;
        if (row.state === 'active' && (r === 'child_safety' || out.count >= cfg.reportsToHide)) {
            await hide(row);
            hidden = true;
        }
        if (r === 'child_safety' && out.added) (log.warn || log.log)(`[OpenVibe.Pics] child-safety report on ${row.id}: hidden until staff review`);
        return { ok: true, added: out.added, count: out.count, hidden };
    }

    /** Staff: restore (active), hide, or take down (removed, bytes deleted, hashes blocklisted). */
    async function moderate(row, action, { by, reason = 'staff' } = {}) {
        if (action === 'restore') {
            if (row.state === 'removed') return { ok: false, row, detail: 'A picture that was taken down stays down; its bytes are gone.' };
            return { ok: true, row: await store.updateImage(s, row.id, { state: 'active' }) };
        }
        if (action === 'hide') return { ok: true, row: row.state === 'active' ? await hide(row) : row };
        if (action !== 'takedown') return { ok: false, row, detail: 'action: restore, hide or takedown' };
        for (const [kind, value] of [['sha256', row.sha256], ['sha256', row.source_sha256], ['dhash', row.dhash]]) {
            if (kind === 'dhash' && !distinctive(value)) continue;
            await store.block(s, { kind, value, reason: cleanLine(reason, 60) || 'staff', imageId: row.id, by });
        }
        await removeObjects(row);
        return { ok: true, row: await store.updateImage(s, row.id, { state: 'removed' }) };
    }

    /** Count a view for the retention clock, at most once an hour per picture. */
    async function viewed(row) {
        const last = Date.parse(row.last_viewed_at || 0);
        if (Number.isFinite(last) && s.now() - last < 3_600_000) return;
        await store.updateImage(s, row.id, { last_viewed_at: s.iso() });
    }

    async function sweep() {
        const before = new Date(s.now() - cfg.anonymousIdleDays * 86_400_000).toISOString();
        const rows = await store.idleAnonymous(s, before);
        for (const row of rows) await remove(row);
        return rows.length;
    }

    // ── Albums (account-only) ───────────────────────────────
    async function createAlbum(owner, { title, description = '' }) {
        const t = cleanLine(title, LIMITS.albumTitle);
        if (!t) return { ok: false, status: 422, code: 'pics.album_title', detail: 'Give the album a name.' };
        if (await store.albumCount(s, owner) >= cfg.albumsMax) return { ok: false, status: 409, code: 'pics.album_limit', detail: `You have ${cfg.albumsMax} albums, the most you can.` };
        const row = await store.insertAlbum(s, { id: s.newId('alb'), slug: slug(), owner, title: t, description: cleanText(description, LIMITS.description), created_at: s.iso() });
        return { ok: true, album: row };
    }

    async function addToAlbum(album, image) {
        if (await store.albumImageCount(s, album.id) >= cfg.albumImagesMax) return { ok: false, status: 409, code: 'pics.album_full', detail: `An album holds ${cfg.albumImagesMax} pictures.` };
        await store.addToAlbum(s, album.id, image.id);
        return { ok: true };
    }

    /** The public links of a picture: its page, the direct file, the thumbnail and the embed snippets. */
    function links(row) {
        const base = cfg.url;
        const page = `${base}/i/${row.slug}`;
        const direct = `${base}/i/${row.slug}.${row.ext}`;
        const alt = altOf(row);
        return {
            page, direct, thumb: `${base}/i/${row.slug}/thumb.webp`,
            markdown: `![${alt.replace(/[[\]]/g, '')}](${direct})`,
            html: `<a href="${page}"><img src="${direct}" alt="${alt.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}"></a>`,
            bbcode: `[url=${page}][img]${direct}[/img][/url]`,
        };
    }

    const toWire = (row, { owner = false } = {}) => ({
        id: row.id, slug: row.slug, title: row.title, description: row.description, mime_type: row.mime_type, ext: row.ext,
        width: Number(row.width), height: Number(row.height), bytes: Number(row.bytes), animated: Boolean(row.animated),
        alt: row.alt || '', alt_source: row.alt_source || null,
        ai: row.ai_described_at ? { caption: row.ai_caption || null, tags: tagsOf(row), described_at: row.ai_described_at } : null,
        state: row.state, created_at: row.created_at, links: links(row),
        ...(owner ? { report_count: Number(row.report_count) } : {}),
    });

    return {
        cfg, REASONS, REASON_TEXT, LIMITS, SLUG_RE, isSlug: (v) => SLUG_RE.test(String(v || '')),
        addressId, canSee, isOwner, upload, edit, remove, deleteKeyMatches, report, moderate, viewed, sweep,
        createAlbum, addToAlbum, links, toWire, isStaff, altOf, tagsOf,
    };
}

module.exports = { createPics, REASONS, SLUG_RE, DHASH_DISTANCE };
