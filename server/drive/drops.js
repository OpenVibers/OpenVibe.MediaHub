'use strict';
/**
 * Drops (migration 0012): a file uploaded to openvibe.download without an account — the owner's Q10, MediaFire-style.
 * Up to 2 GB in the drive's 8 MB parts, an ownerless OpenVibe.Media object, a public page /d/<slug> and a delete key
 * shown once. Kept 30 days after its last download. Off until MEDIAHUB_DOWNLOAD_ANONYMOUS=1 (plan T10's gate: the DMCA
 * agent and the CSAM hash-matching account, as for Pics' signed-out uploads).
 *
 *   start({ ip, name, size, contentType })   per-address limits, a Media multipart session → { upload, token }
 *   parts / status / abort                   the drive's own session code (server/drive/upload.js), the session's
 *                                            owner being `drop:<sha256 of the token>`: the token, not the address,
 *                                            proves the session is yours (a phone that changes network keeps going)
 *   complete({ token, id })                  Media assembles it; a blocklisted sha256 is refused and deleted →
 *                                            { drop, deleteKey }
 *   report / suspend / restore / remove      reports suspend (illegal at once, else three distinct); staff restore or
 *                                            remove, and a removed drop's sha256 is blocklisted
 *   sweep()                                  drops nobody downloaded for idleDays are deleted (bytes and all)
 */
const crypto = require('crypto');
const store = require('./store');
const rules = require('./rules');

const SLUG_RE = /^[A-Za-z0-9_-]{24}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function createDrops({ s, media, config, uploads, log = console }) {
    const cfg = config.drops;
    const addressKey = crypto.createHash('sha256').update(`download-address:${config.oauth.clientSecret || 'dev'}`).digest();
    const addressId = (ip) => `ip:${crypto.createHmac('sha256', addressKey).update(String(ip || 'unknown')).digest('hex').slice(0, 32)}`;
    const ownerOf = (token) => `drop:${sha256(token)}`;
    const dayStart = () => `${new Date(s.now()).toISOString().slice(0, 10)}T00:00:00.000Z`;

    const get = (slug) => (SLUG_RE.test(String(slug || '')) ? s.db.maybe('SELECT * FROM mh_drops WHERE slug = $1', [String(slug)]) : null);

    async function start({ ip, name, size, contentType }) {
        if (!cfg.enabled) return { ok: false, status: 403, code: 'drop.off', detail: 'Uploads without an account are not open yet. Sign in to upload to your own drive.' };
        const bytes = Number(size);
        if (!Number.isSafeInteger(bytes) || bytes < 1) return { ok: false, status: 422, code: 'file.invalid_size', detail: 'A file needs a size of at least one byte.' };
        if (bytes > cfg.maxBytes) return { ok: false, status: 413, code: 'file.too_large', detail: `A file uploaded without an account may be at most ${rules.formatBytes(cfg.maxBytes)}.` };
        const uploader = addressId(ip);
        const today = await s.db.one(
            "SELECT count(*)::int AS n, coalesce(sum(size), 0)::bigint AS b FROM mh_drops WHERE uploader = $1 AND created_at >= $2", [uploader, dayStart()]);
        if (Number(today.n) >= cfg.perDay) return { ok: false, status: 429, code: 'file.daily_limit', detail: `${cfg.perDay} uploads a day without an account. Sign in for your own drive, or try again tomorrow.` };
        if (Number(today.b) + bytes > cfg.bytesPerDay) return { ok: false, status: 429, code: 'file.daily_limit', detail: `${rules.formatBytes(cfg.bytesPerDay)} a day without an account. Sign in for your own drive, or try again tomorrow.` };
        const fileName = rules.fileName(name, 'file');
        const type = rules.normalizeType(contentType) || 'application/octet-stream';
        const started = await media.init({ size: bytes, contentType: type, name: fileName, multipart: true, partSize: config.partBytes, ownerless: true });
        if (!started.ok) return { ok: false, status: 502, code: started.code, detail: started.detail };
        const objectId = started.data.id;
        let session = started.data.upload && started.data.upload.multipart;
        if (!session || !session.upload_id) {
            const fresh = await media.multipartStart(objectId, { size: bytes, partSize: config.partBytes });
            if (!fresh.ok) {
                await media.remove(objectId);
                return { ok: false, status: 502, code: fresh.code, detail: fresh.detail };
            }
            session = fresh.data;
        }
        const token = crypto.randomBytes(24).toString('base64url');
        const row = await store.insertUpload(s, {
            id: s.newId('upl'), owner: ownerOf(token), object_id: objectId, upload_id: session.upload_id,
            name: fileName, size: bytes, content_type: type, folder_id: null, drop_uploader: uploader,
            part_size: session.part_size, parts_expected: session.parts_expected,
            created_at: s.iso(), expires_at: new Date(s.now() + config.uploadTtlSeconds * 1000).toISOString(),
        });
        return { ok: true, token, upload: { id: row.id, name: fileName, size: bytes, content_type: type, part_size: row.part_size, parts_expected: row.parts_expected, missing: [], expires_at: row.expires_at } };
    }

    const sessionOwner = (token) => (TOKEN_RE.test(String(token || '')) ? ownerOf(token) : null);
    const putPart = (token, id, n, buffer) => {
        const owner = sessionOwner(token);
        return owner ? uploads.putPart(owner, id, n, buffer) : { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
    };
    const status = (token, id) => {
        const owner = sessionOwner(token);
        return owner ? uploads.status(owner, id) : { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
    };
    const abort = (token, id) => {
        const owner = sessionOwner(token);
        return owner ? uploads.abort(owner, id) : { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
    };

    async function complete({ token, id }) {
        const owner = sessionOwner(token);
        const row = owner ? await store.getUpload(s, String(id || '')) : null;
        if (!row || row.owner !== owner || row.expires_at <= s.iso()) return { ok: false, status: 404, code: 'upload.not_found', detail: 'No such upload.' };
        const done = await media.completeMultipart(row.object_id, row.upload_id);
        if (!done.ok) return { ok: false, status: 502, code: done.code, detail: done.detail };
        const object = done.data || {};
        const hash = object.content_hash || null;
        await store.dropUpload(s, row.id);
        if (hash && await s.db.maybe('SELECT 1 FROM mh_drop_blocklist WHERE sha256 = $1', [hash])) {
            await media.remove(row.object_id);
            return { ok: false, status: 451, code: 'drop.blocked', detail: 'This file was taken down from OpenVibe.Download and cannot be uploaded again.' };
        }
        const deleteKey = crypto.randomBytes(18).toString('base64url');
        const drop = await s.db.one(
            `INSERT INTO mh_drops (id, slug, object_id, name, size, content_type, sha256, uploader, delete_key_hash, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [s.newId('drp'), crypto.randomBytes(18).toString('base64url'), row.object_id, row.name,
                Number(object.size_bytes) || row.size, object.mime_type || row.content_type, hash, row.drop_uploader || 'ip:unknown', sha256(deleteKey), s.iso()]);
        return { ok: true, drop, deleteKey };
    }

    const countDownload = (drop) => s.db.exec('UPDATE mh_drops SET downloads = downloads + 1, last_download_at = $2 WHERE id = $1', [drop.id, s.iso()]);

    function keyMatches(drop, key) {
        if (!drop || typeof key !== 'string' || !key) return false;
        const a = Buffer.from(sha256(key));
        const b = Buffer.from(drop.delete_key_hash);
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    }

    /** Delete it (bytes and all); `block` puts its sha256 on the blocklist (a staff takedown). */
    async function remove(drop, { block = false } = {}) {
        if (!drop || drop.state === 'removed') return false;
        const gone = await media.remove(drop.object_id);
        if (!gone.ok && gone.status !== 404) log.warn(`[MediaHub] drop ${drop.id}: Media refused the delete: ${gone.status} ${gone.code}`);
        await s.db.exec("UPDATE mh_drops SET state = 'removed', removed_at = $2 WHERE id = $1", [drop.id, s.iso()]);
        if (block && drop.sha256) {
            await s.db.exec('INSERT INTO mh_drop_blocklist (sha256, drop_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO NOTHING', [drop.sha256, drop.id, s.iso()]);
        }
        return true;
    }

    async function report(drop, { reporter, reason, note }) {
        if (!rules.REASONS.includes(reason)) return { ok: false, code: 'report.reason', detail: 'Choose why.' };
        const added = await s.db.maybe(
            'INSERT INTO mh_drop_reports (drop_id, reporter, reason, note, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (drop_id, reporter) DO NOTHING RETURNING drop_id',
            [drop.id, reporter, reason, rules.cleanText(note, 500), s.iso()]);
        if (!added) return { ok: true, recorded: false };
        const n = Number(await s.db.value('SELECT count(*) FROM mh_drop_reports WHERE drop_id = $1', [drop.id]));
        const suspend = drop.state === 'active' && (rules.SUSPEND_IMMEDIATELY.includes(reason) || n >= rules.SUSPEND_AT_REPORTS);
        await s.db.exec(`UPDATE mh_drops SET report_count = $2${suspend ? ", state = 'suspended'" : ''} WHERE id = $1`, [drop.id, n]);
        return { ok: true, recorded: true, suspended: suspend };
    }

    const restore = (drop) => s.db.exec("UPDATE mh_drops SET state = 'active' WHERE id = $1 AND state = 'suspended'", [drop.id]);
    const suspended = () => s.db.many("SELECT * FROM mh_drops WHERE state = 'suspended' ORDER BY created_at DESC LIMIT 200");

    /** Drops nobody has downloaded for idleDays: deleted. → how many. */
    async function sweep() {
        const before = new Date(s.now() - cfg.idleDays * 86_400_000).toISOString();
        const idle = await s.db.many(
            "SELECT * FROM mh_drops WHERE state <> 'removed' AND coalesce(last_download_at, created_at) < $1 ORDER BY id LIMIT 200", [before]);
        let n = 0;
        for (const drop of idle) if (await remove(drop)) n++;
        return n;
    }

    return { enabled: () => cfg.enabled, config: cfg, addressId, get, start, putPart, status, abort, complete, countDownload, keyMatches, remove, report, restore, suspended, sweep };
}

module.exports = { createDrops, SLUG_RE };
