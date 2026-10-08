'use strict';

/**
 * Files, folders, shares, reports and upload counters in OpenVibe.MediaHub's PostgreSQL database
 * (migrations/0002_mediahub.sql). Every function takes the store (server/db.js createStore) first; the clock is the
 * store's own, so a test can move time and watch a share expire.
 *
 * Two rules live here because SQL is where they cannot be raced:
 *   - a report is one per person per share (the primary key, not a read followed by a write),
 *   - the upload counter is one row per person per day (upsert).
 * Everything else (who may see what, which limits apply) is server/drive/service.js.
 */

const FILES = 'mh_files';
const FOLDERS = 'mh_folders';
const SHARES = 'mh_shares';
const REPORTS = 'mh_reports';
const USAGE = 'mh_usage';
const UPLOADS = 'mh_uploads';

// ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertFile(s, row) {
    await s.db.query(
        `INSERT INTO ${FILES} (id, owner, object_id, name, size, content_type, sha256, folder_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [row.id, row.owner, row.object_id, row.name, row.size, row.content_type, row.sha256, row.folder_id, row.created_at]);
    return getFile(s, row.id);
}

const getFile = (s, id) => s.db.maybe(`SELECT * FROM ${FILES} WHERE id = $1`, [id]);

/** This person's live files: newest first, a page at a time, optionally one folder (null = the root). */
async function listFiles(s, owner, { folderId = null, limit = 100, before = null } = {}) {
    const values = [owner];
    const parts = ['owner = $1', 'deleted_at IS NULL'];
    if (folderId === null) parts.push('folder_id IS NULL');
    else { values.push(folderId); parts.push(`folder_id = $${values.length}`); }
    let sql = `SELECT * FROM ${FILES} WHERE ${parts.join(' AND ')}`;
    if (before) { values.push(before); sql += ` AND id < $${values.length}`; }
    values.push(limit);
    sql += ` ORDER BY id DESC LIMIT $${values.length}`;
    return s.db.many(sql, values);
}

/** Every size the person still holds — what the quota bar is drawn from. */
const storedBytes = (s, owner) => s.db.value(`SELECT coalesce(sum(size), 0) FROM ${FILES} WHERE owner = $1 AND deleted_at IS NULL`, [owner]).then(Number);

const liveFileCount = (s, owner) => s.db.value(`SELECT count(*) FROM ${FILES} WHERE owner = $1 AND deleted_at IS NULL`, [owner]).then(Number);

/** Soft delete: the row stays (it is what the Media object is written from), the person stops seeing it. */
const softDeleteFile = (s, id, at) => s.db.exec(`UPDATE ${FILES} SET deleted_at = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, at]);

// ── Folders ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertFolder(s, row) {
    await s.db.query(`INSERT INTO ${FOLDERS} (id, owner, parent_id, name, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.owner, row.parent_id, row.name, row.created_at]);
    return getFolder(s, row.id);
}

const getFolder = (s, id) => s.db.maybe(`SELECT * FROM ${FOLDERS} WHERE id = $1`, [id]);
const listFolders = (s, owner) => s.db.many(`SELECT * FROM ${FOLDERS} WHERE owner = $1 ORDER BY lower(name) ASC, id ASC`, [owner]);
const countFolders = (s, owner) => s.db.value(`SELECT count(*) FROM ${FOLDERS} WHERE owner = $1`, [owner]).then(Number);
const deleteFolder = (s, id, owner) => s.db.exec(`DELETE FROM ${FOLDERS} WHERE id = $1 AND owner = $2`, [id, owner]);

// ── Shares ──────────────────────────────────────────────────────────────────────────────────────────────────────

async function insertShare(s, row) {
    await s.db.query(
        `INSERT INTO ${SHARES} (slug, file_id, folder_id, owner, owner_username, expires_at, allowed_subjects, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [row.slug, row.file_id, row.folder_id, row.owner, row.owner_username || null, row.expires_at,
            row.allowed_subjects ? JSON.stringify(row.allowed_subjects) : null, row.created_at]);
    return getShare(s, row.slug);
}

const getShare = (s, slug) => s.db.maybe(`SELECT * FROM ${SHARES} WHERE slug = $1`, [slug]);
const listShares = (s, owner) => s.db.many(`SELECT * FROM ${SHARES} WHERE owner = $1 ORDER BY created_at DESC, slug DESC`, [owner]);

/** Live = not revoked, not suspended and not past its expiry: what the per-person share cap counts. */
const countLiveShares = (s, owner, nowIso) => s.db.value(
    `SELECT count(*) FROM ${SHARES} WHERE owner = $1 AND revoked_at IS NULL AND suspended_at IS NULL AND expires_at > $2`,
    [owner, nowIso]).then(Number);

const revokeShare = (s, slug, at) => s.db.exec(`UPDATE ${SHARES} SET revoked_at = $2 WHERE slug = $1 AND revoked_at IS NULL`, [slug, at]);
const suspendShare = (s, slug, at) => s.db.exec(`UPDATE ${SHARES} SET suspended_at = $2 WHERE slug = $1 AND suspended_at IS NULL`, [slug, at]);
const restoreShare = (s, slug) => s.db.exec(`UPDATE ${SHARES} SET suspended_at = NULL WHERE slug = $1`, [slug]);

/** One more download, counted where the row is: a shared counter cannot lose one. */
const countDownload = (s, slug) => s.db.exec(`UPDATE ${SHARES} SET downloads = downloads + 1 WHERE slug = $1`, [slug]);

const deleteSharesForFile = (s, fileId) => s.db.exec(`DELETE FROM ${SHARES} WHERE file_id = $1`, [fileId]);
const deleteSharesForFolder = (s, folderId) => s.db.exec(`DELETE FROM ${SHARES} WHERE folder_id = $1`, [folderId]);

// ── Reports ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Record a report. The primary key is the truth: one per person per share, raced or not. */
async function addReport(s, { slug, reporter, reason, note, createdAt }) {
    try {
        await s.db.query(`INSERT INTO ${REPORTS} (slug, reporter, reason, note, created_at) VALUES ($1, $2, $3, $4, $5)`,
            [slug, reporter, reason, note, createdAt]);
    } catch (err) {
        if (err && err.code === '23505') return null;      // already reported by this person
        throw err;
    }
    return s.db.maybe(`SELECT * FROM ${REPORTS} WHERE slug = $1 AND reporter = $2`, [slug, reporter]);
}

const reportsFor = (s, slug) => s.db.many(`SELECT * FROM ${REPORTS} WHERE slug = $1 ORDER BY created_at ASC`, [slug]);
const reportCount = (s, slug) => s.db.value(`SELECT count(*) FROM ${REPORTS} WHERE slug = $1`, [slug]).then(Number);

/** The high-water mark of how many reports this share has had: it only ever goes up, so restoring it sticks. */
const bumpReportCount = (s, slug, count) => s.db.value(`UPDATE ${SHARES} SET report_count = greatest(report_count, $2) WHERE slug = $1 RETURNING report_count`, [slug, count]).then(Number);

/** The staff queue: every share somebody reported, the newest report first. */
function staffQueue(s, { limit = 100 } = {}) {
    return s.db.many(
        `SELECT sh.*, max(r.created_at) AS last_report_at, count(r.reporter) AS report_count
           FROM ${SHARES} sh JOIN ${REPORTS} r ON r.slug = sh.slug
          GROUP BY sh.slug
          ORDER BY max(r.created_at) DESC
          LIMIT $1`, [limit]);
}

async function staffCounts(s) {
    const [reported, suspended, revoked] = await Promise.all([
        s.db.value(`SELECT count(DISTINCT slug) FROM ${REPORTS}`),
        s.db.value(`SELECT count(*) FROM ${SHARES} WHERE suspended_at IS NOT NULL`),
        s.db.value(`SELECT count(*) FROM ${SHARES} WHERE revoked_at IS NOT NULL`),
    ]);
    return { reported: Number(reported), suspended: Number(suspended), revoked: Number(revoked) };
}

// ── Usage (uploads per person per day, UTC) ─────────────────────────────────────────────────────────────────────

/** Record one upload today, answering the new count for the day. */
async function bumpUploads(s, owner, day) {
    const row = await s.db.maybe(
        `INSERT INTO ${USAGE} (owner, day, uploads) VALUES ($1, $2, 1)
         ON CONFLICT (owner, day) DO UPDATE SET uploads = ${USAGE}.uploads + 1
         RETURNING uploads`, [owner, day]);
    return Number(row && row.uploads);
}

const uploadsToday = (s, owner, day) => s.db.value(`SELECT uploads FROM ${USAGE} WHERE owner = $1 AND day = $2`, [owner, day]).then((v) => Number(v) || 0);
const usageFor = (s, owner) => s.db.many(`SELECT * FROM ${USAGE} WHERE owner = $1 ORDER BY day DESC LIMIT 90`, [owner]);

// ── Upload sessions (a chunked upload in flight) ────────────────────────────────────────────────────────────────

async function insertUpload(s, row) {
    await s.db.query(
        `INSERT INTO ${UPLOADS} (id, owner, object_id, upload_id, name, size, content_type, folder_id, part_size, parts_expected, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [row.id, row.owner, row.object_id, row.upload_id, row.name, row.size, row.content_type, row.folder_id,
            row.part_size, row.parts_expected, row.created_at, row.expires_at]);
    return getUpload(s, row.id);
}

const getUpload = (s, id) => s.db.maybe(`SELECT * FROM ${UPLOADS} WHERE id = $1`, [id]);
const setUploadFile = (s, id, fileId) => s.db.exec(`UPDATE ${UPLOADS} SET file_id = $2 WHERE id = $1`, [id, fileId]);
const dropUpload = (s, id) => s.db.exec(`DELETE FROM ${UPLOADS} WHERE id = $1`, [id]);

module.exports = {
    insertFile, getFile, listFiles, storedBytes, liveFileCount, softDeleteFile,
    insertFolder, getFolder, listFolders, countFolders, deleteFolder,
    insertShare, getShare, listShares, countLiveShares, revokeShare, suspendShare, restoreShare, countDownload,
    deleteSharesForFile, deleteSharesForFolder,
    addReport, reportsFor, reportCount, bumpReportCount, staffQueue, staffCounts,
    bumpUploads, uploadsToday, usageFor,
    insertUpload, getUpload, setUploadFile, dropUpload,
};
