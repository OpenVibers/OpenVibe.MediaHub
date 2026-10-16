'use strict';

/**
 * OpenVibe.Pics' rows (migrations/0006_pics.sql). Every function takes the store (server/db.js createStore) first.
 * Pictures and albums are read by slug from the pages and by id inside; a picture that is not `active` is shown to
 * nobody but its uploader and staff (server/pics/service.js decides who).
 */

const IMAGE_COLS = ['title', 'description', 'state', 'report_count', 'last_viewed_at', 'thumb_object_id', 'alt', 'alt_source', 'ai_caption', 'ai_tags', 'ai_described_at'];

const imageBySlug = (s, slug) => s.db.maybe('SELECT * FROM pics_images WHERE slug = $1', [slug]);
const imageById = (s, id) => s.db.maybe('SELECT * FROM pics_images WHERE id = $1', [id]);

async function insertImage(s, row) {
    await s.db.query(
        `INSERT INTO pics_images (id, slug, owner, delete_key_hash, title, description, object_id, thumb_object_id, mime_type, ext,
                width, height, bytes, animated, sha256, source_sha256, dhash, state, report_count, created_at, updated_at, last_viewed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'active', 0, $18, $18, $18)`,
        [row.id, row.slug, row.owner, row.delete_key_hash, row.title, row.description, row.object_id, row.thumb_object_id, row.mime_type,
            row.ext, row.width, row.height, row.bytes, row.animated, row.sha256, row.source_sha256, row.dhash, row.created_at]);
    return imageById(s, row.id);
}

async function updateImage(s, id, patch) {
    const cols = IMAGE_COLS.filter((c) => patch[c] !== undefined);
    if (!cols.length) return imageById(s, id);
    await s.db.query(`UPDATE pics_images SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = $2 WHERE id = $1`, [id, s.iso(), ...cols.map((c) => patch[c])]);
    return imageById(s, id);
}

const deleteImage = (s, id) => s.db.exec('DELETE FROM pics_images WHERE id = $1', [id]);

/** A person's pictures, newest first, a page at a time by id cursor. */
async function imagesOf(s, owner, { limit = 48, before = null } = {}) {
    const rows = await s.db.many(
        `SELECT * FROM pics_images WHERE owner = $1 AND state <> 'removed' ${before ? 'AND id < $3' : ''} ORDER BY id DESC LIMIT $2`,
        before ? [owner, limit + 1, before] : [owner, limit + 1]);
    return { rows: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
}

const usageOf = async (s, owner) => {
    const r = await s.db.maybe("SELECT count(*)::int AS n, coalesce(sum(bytes), 0)::bigint AS bytes FROM pics_images WHERE owner = $1 AND state <> 'removed'", [owner]);
    return { images: Number(r ? r.n : 0), bytes: Number(r ? r.bytes : 0) };
};

/** Count one upload for an uploader today; answers the count after it. */
async function countUpload(s, uploader, day) {
    return Number(await s.db.value(
        `INSERT INTO pics_usage (uploader, day, uploads) VALUES ($1, $2, 1)
         ON CONFLICT (uploader, day) DO UPDATE SET uploads = pics_usage.uploads + 1 RETURNING uploads`, [uploader, day]));
}
const uploadsToday = async (s, uploader, day) => Number(await s.db.value('SELECT coalesce(max(uploads), 0) FROM pics_usage WHERE uploader = $1 AND day = $2', [uploader, day]));

// ── Blocklist ───────────────────────────────────────────────
const blockedSha = (s, values) => s.db.maybe("SELECT * FROM pics_blocklist WHERE kind = 'sha256' AND value = ANY($1::text[])", [values]);
const blockedDhashes = (s) => s.db.many("SELECT value, reason FROM pics_blocklist WHERE kind = 'dhash'");
async function block(s, { kind, value, reason, imageId, by }) {
    await s.db.query(
        `INSERT INTO pics_blocklist (kind, value, reason, image_id, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (kind, value) DO NOTHING`, [kind, value, reason, imageId, by, s.iso()]);
}

// ── Reports ─────────────────────────────────────────────────
/** One report per reporter per picture: { added, count } — `added` false when this reporter had already reported it. */
async function addReport(s, imageId, { id, reporter, reason, note }) {
    const ins = await s.db.maybe(
        `INSERT INTO pics_reports (id, image_id, reporter, reason, note, created_at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (image_id, reporter) DO NOTHING RETURNING id`, [id, imageId, reporter, reason, note, s.iso()]);
    const count = Number(await s.db.value('SELECT count(*)::int FROM pics_reports WHERE image_id = $1', [imageId]));
    await s.db.query('UPDATE pics_images SET report_count = $2 WHERE id = $1', [imageId, count]);
    return { added: Boolean(ins), count };
}
const reportsFor = (s, imageId) => s.db.many('SELECT * FROM pics_reports WHERE image_id = $1 ORDER BY created_at DESC', [imageId]);

/** The staff queue: hidden pictures first (waiting on a decision), then reported active ones. */
const staffQueue = (s, { state = 'hidden', limit = 60 } = {}) => s.db.many(
    state === 'reported'
        ? "SELECT * FROM pics_images WHERE state = 'active' AND report_count > 0 ORDER BY report_count DESC, id DESC LIMIT $1"
        : 'SELECT * FROM pics_images WHERE state = $2 ORDER BY id DESC LIMIT $1',
    state === 'reported' ? [limit] : [limit, state]);
const staffCounts = async (s) => {
    const rows = await s.db.many("SELECT state, count(*)::int AS n FROM pics_images WHERE state <> 'active' OR report_count > 0 GROUP BY state");
    const reported = Number(await s.db.value("SELECT count(*)::int FROM pics_images WHERE state = 'active' AND report_count > 0"));
    return { hidden: Number((rows.find((r) => r.state === 'hidden') || {}).n || 0), removed: Number((rows.find((r) => r.state === 'removed') || {}).n || 0), reported };
};

/** Signed-out pictures nobody has looked at since `beforeIso`: the retention sweep's work. */
const idleAnonymous = (s, beforeIso, limit = 200) => s.db.many(
    "SELECT * FROM pics_images WHERE owner IS NULL AND state <> 'removed' AND coalesce(last_viewed_at, created_at) < $1 ORDER BY id LIMIT $2", [beforeIso, limit]);

// ── Albums ──────────────────────────────────────────────────
const albumBySlug = (s, slug) => s.db.maybe('SELECT * FROM pics_albums WHERE slug = $1', [slug]);
const albumsOf = (s, owner) => s.db.many(
    `SELECT a.*, (SELECT count(*)::int FROM pics_album_images ai WHERE ai.album_id = a.id) AS image_count,
            (SELECT i.slug FROM pics_album_images ai JOIN pics_images i ON i.id = ai.image_id WHERE ai.album_id = a.id AND i.state = 'active' ORDER BY ai.position LIMIT 1) AS cover_slug
     FROM pics_albums a WHERE a.owner = $1 ORDER BY a.id DESC`, [owner]);
const albumCount = async (s, owner) => Number(await s.db.value('SELECT count(*)::int FROM pics_albums WHERE owner = $1', [owner]));

async function insertAlbum(s, row) {
    await s.db.query('INSERT INTO pics_albums (id, slug, owner, title, description, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
        [row.id, row.slug, row.owner, row.title, row.description, row.created_at]);
    return albumBySlug(s, row.slug);
}
async function updateAlbum(s, id, { title, description }) {
    await s.db.query('UPDATE pics_albums SET title = coalesce($2, title), description = coalesce($3, description), updated_at = $4 WHERE id = $1', [id, title, description, s.iso()]);
}
const deleteAlbum = (s, id) => s.db.exec('DELETE FROM pics_albums WHERE id = $1', [id]);

/** The album's pictures in order; `visibleOnly` leaves out the hidden and removed ones (everyone but the owner). */
const albumImages = (s, albumId, { visibleOnly = true } = {}) => s.db.many(
    `SELECT i.* FROM pics_album_images ai JOIN pics_images i ON i.id = ai.image_id
     WHERE ai.album_id = $1 ${visibleOnly ? "AND i.state = 'active'" : "AND i.state <> 'removed'"} ORDER BY ai.position, ai.added_at`, [albumId]);
const albumImageCount = async (s, albumId) => Number(await s.db.value('SELECT count(*)::int FROM pics_album_images WHERE album_id = $1', [albumId]));
async function addToAlbum(s, albumId, imageId) {
    const pos = Number(await s.db.value('SELECT coalesce(max(position), 0) + 1 FROM pics_album_images WHERE album_id = $1', [albumId]));
    await s.db.query('INSERT INTO pics_album_images (album_id, image_id, position, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [albumId, imageId, pos, s.iso()]);
    await s.db.query('UPDATE pics_albums SET updated_at = $2 WHERE id = $1', [albumId, s.iso()]);
}
const removeFromAlbum = (s, albumId, imageId) => s.db.exec('DELETE FROM pics_album_images WHERE album_id = $1 AND image_id = $2', [albumId, imageId]);
const albumsHolding = (s, imageId) => s.db.many('SELECT a.* FROM pics_album_images ai JOIN pics_albums a ON a.id = ai.album_id WHERE ai.image_id = $1 ORDER BY a.title', [imageId]);

module.exports = {
    imageBySlug, imageById, insertImage, updateImage, deleteImage, imagesOf, usageOf, countUpload, uploadsToday,
    blockedSha, blockedDhashes, block, addReport, reportsFor, staffQueue, staffCounts, idleAnonymous,
    albumBySlug, albumsOf, albumCount, insertAlbum, updateAlbum, deleteAlbum, albumImages, albumImageCount, addToAlbum, removeFromAlbum, albumsHolding,
};
