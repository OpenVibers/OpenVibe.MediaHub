'use strict';

/**
 * The rules that need the database, shared by the pages (http/pages.js) and the API (http/api.js) so a form and a
 * POST enforce the same numbers:
 *
 *   a person, never an app or a service   (the guard lives in http/api.js and http/pages.js)
 *   2 GB stored, 512 MB per file, 50 uploads a day (UTC), 20 live share links   (every number from the environment)
 *   a share expires in 1 hour to 7 days (7 by default), can be revoked and counts its downloads
 *   a share may name people: resolved to subjects, and matched on the viewer's username claim as well
 *   3 distinct reports, or one report of illegal content, suspend a share at once
 *
 * A refusal is { ok: false, code, detail }: an API problem+json, or the sentence the form re-renders with.
 *
 * Nothing here trusts a caller's identity: the caller passes the requester it already established, and this module
 * only ever compares it with what the rows say.
 */
const crypto = require('crypto');
const rules = require('./rules');
const store = require('./store');

const DAY_MS = 86_400_000;

/** The UTC day a moment falls in — what "50 uploads a day" is counted over. */
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** The allow-list a share carries, as stored: { subjects, usernames } or null for "any signed-in person". */
function parseAllow(value) {
    if (!value) return null;
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    if (!v || typeof v !== 'object') return null;
    const list = (x) => (Array.isArray(x) ? x.filter((s) => typeof s === 'string') : []);
    const subjects = list(v.subjects);
    const usernames = list(v.usernames).map((u) => u.toLowerCase());
    if (!subjects.length && !usernames.length) return { subjects: [], usernames: [] };
    return { subjects, usernames };
}

/**
 * May this viewer open the share? `viewer` is { subject, username } of a signed-in person — the caller has already
 * refused everyone else. An allow-list is satisfied only by the person's canonical subject, resolved when the share
 * was made: a username is a label that can change hands, a subject is the account.
 */
function allowedFor(share, viewer) {
    const allow = parseAllow(share.allowed_subjects);
    if (!allow) return true;
    const subject = viewer && viewer.subject;
    return Boolean(subject && allow.subjects.includes(subject));
}

/** Where a share stands right now: what the page shows and what a download checks. */
function stateOf(share, nowIso) {
    if (!share) return 'missing';
    if (share.revoked_at) return 'revoked';
    if (share.suspended_at) return 'suspended';
    if (share.expires_at <= nowIso) return 'expired';
    return 'live';
}

/** A slug nobody can guess by looking at another one: 18 random bytes, url-safe. */
const newSlug = () => crypto.randomBytes(18).toString('base64url');

function createService({ s, media, identity, config, log = console }) {
    const nowIso = () => new Date(s.now()).toISOString();

    // ── Limits ──────────────────────────────────────────────

    /** Room for one more file of `size` bytes, and for uploads not to run past the day's cap. */
    async function uploadAllowed(owner, size) {
        if (!Number.isInteger(size) || size < 1) return { ok: false, code: 'file.invalid_size', detail: 'A file needs a size of at least one byte.' };
        if (size > config.quotas.maxFileBytes) {
            return { ok: false, code: 'file.too_large', detail: `One file may be at most ${rules.formatBytes(config.quotas.maxFileBytes)}. This one is ${rules.formatBytes(size)}.` };
        }
        const used = await store.storedBytes(s, owner);
        if (used + size > config.quotas.bytes) {
            return { ok: false, code: 'file.quota', detail: `Your drive holds ${rules.formatBytes(used)} of ${rules.formatBytes(config.quotas.bytes)}. This file needs ${rules.formatBytes(size)} more; delete something first.` };
        }
        const today = await store.uploadsToday(s, owner, dayOf(s.now()));
        if (today >= config.quotas.uploadsPerDay) {
            return { ok: false, code: 'file.daily_limit', detail: `You have uploaded ${config.quotas.uploadsPerDay} files today (the most one person may). Try again tomorrow.` };
        }
        return { ok: true };
    }

    /** Room for one more live share link. */
    async function shareAllowed(owner) {
        const live = await store.countLiveShares(s, owner, nowIso());
        if (live >= config.quotas.maxShares) {
            return { ok: false, code: 'share.limit', detail: `You have ${config.quotas.maxShares} live share links (the most one person may have). Revoke one first — /files lists them.` };
        }
        return { ok: true };
    }

    /** The usage bar on /files and GET /usage. */
    async function usage(owner) {
        const [used, files, today, liveShares] = await Promise.all([
            store.storedBytes(s, owner), store.liveFileCount(s, owner),
            store.uploadsToday(s, owner, dayOf(s.now())), store.countLiveShares(s, owner, nowIso()),
        ]);
        return {
            bytes_used: used, bytes_limit: config.quotas.bytes,
            max_file_bytes: config.quotas.maxFileBytes,
            files, uploads_today: today, uploads_per_day: config.quotas.uploadsPerDay,
            live_shares: liveShares, max_shares: config.quotas.maxShares,
        };
    }

    // ── Files ───────────────────────────────────────────────

    /**
     * Record an object that is already `ready` in Media as one of the person's files, and count the upload.
     * The quota is checked again here: the bytes exist now, which is what the number is about.
     */
    async function recordFile({ owner, objectId, name, size, contentType, sha256, folderId = null }) {
        const row = await store.insertFile(s, {
            id: s.newId('fil'), owner, object_id: objectId, name: rules.fileName(name),
            size, content_type: rules.normalizeType(contentType) || 'application/octet-stream',
            sha256: sha256 || null, folder_id: folderId, created_at: nowIso(),
        });
        await store.bumpUploads(s, owner, dayOf(s.now()));
        return row;
    }

    /** One of the person's own files, or null. A file is private: nobody else's id resolves here. */
    const ownFile = async (owner, id) => {
        if (!rules.isFileId(id)) return null;
        const row = await store.getFile(s, id);
        return row && row.owner === owner && !row.deleted_at ? row : null;
    };

    /**
     * Delete a file: its shares go at once, the row is soft-deleted here and the object is deleted in Media.
     * The bytes are Media's to keep or purge (Media's own retention), so this does not claim they are gone.
     */
    async function deleteFile(owner, id, { by = null } = {}) {
        const row = await ownFile(owner, id);
        if (!row) return { error: 'file.not_found' };
        await store.deleteSharesForFile(s, id);
        await store.softDeleteFile(s, id, nowIso());
        const removed = await media.remove(row.object_id);
        if (!removed.ok) log.warn(`[MediaHub] Media refused to delete ${row.object_id}: ${removed.status} ${removed.code}`);
        return { file: row, media: removed };
    }

    // ── Folders ─────────────────────────────────────────────

    /** A folder of this person's, or null. */
    const ownFolder = async (owner, id) => {
        if (!rules.isFolderId(id)) return null;
        const row = await store.getFolder(s, id);
        return row && row.owner === owner ? row : null;
    };

    async function createFolder(owner, { name, parentId = null }) {
        const clean = rules.cleanName(name, rules.FOLDER_NAME_MAX);
        if (!clean) return { error: 'folder.invalid_name', detail: 'A folder needs a name.' };
        if (parentId && !await ownFolder(owner, parentId)) return { error: 'folder.no_parent', detail: 'That parent folder does not exist.' };
        const existing = await store.listFolders(s, owner);
        if (existing.some((f) => (f.parent_id || null) === (parentId || null) && f.name.toLowerCase() === clean.toLowerCase())) {
            return { error: 'folder.exists', detail: `You already have a folder called "${clean}" here.` };
        }
        return { folder: await store.insertFolder(s, { id: s.newId('fld'), owner, parent_id: parentId || null, name: clean, created_at: nowIso() }) };
    }

    /** A folder's path from the root, for breadcrumbs and the folder picker. */
    async function folderPath(owner, folderId) {
        const all = await store.listFolders(s, owner);
        const byId = new Map(all.map((f) => [f.id, f]));
        const path = [];
        let cursor = folderId;
        let guard = 0;
        while (cursor && byId.has(cursor) && guard++ < 50) { path.unshift(byId.get(cursor)); cursor = byId.get(cursor).parent_id; }
        return path;
    }

    // ── Shares ──────────────────────────────────────────────

    /**
     * Make a share link for one of the person's files or folders. `names` are OpenVibe usernames the owner typed:
     * each is asked of Network's identity resolver, and the ones it cannot resolve are kept as typed and matched
     * against a viewer's username claim later. No names at all = any signed-in person with the link.
     */
    async function createShare(owner, { fileId = null, folderId = null, hours, names = [], ownerUsername = null }) {
        const room = await shareAllowed(owner);
        if (!room.ok) return room;
        if (fileId && !await ownFile(owner, fileId)) return { ok: false, code: 'file.not_found', detail: 'No such file.' };
        if (folderId && !await ownFolder(owner, folderId)) return { ok: false, code: 'folder.not_found', detail: 'No such folder.' };
        if (!fileId && !folderId) return { ok: false, code: 'share.invalid', detail: 'A share names one file or one folder.' };
        if (fileId && folderId) return { ok: false, code: 'share.invalid', detail: 'A share names one file or one folder, not both.' };
        const wanted = [...new Set(names.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))];
        for (const n of wanted) {
            if (!rules.isUsername(n)) return { ok: false, code: 'share.bad_username', detail: `"${rules.cleanName(n, 40)}" is not an OpenVibe username.` };
        }
        const resolved = wanted.length ? await identity.resolveUsernames(wanted) : { subjects: [], names: [], unresolved: [] };
        if (resolved.unresolved.length) {
            return { ok: false, code: 'share.unknown_user', detail: `No OpenVibe account is called ${resolved.unresolved.map((n) => `@${rules.cleanName(n, 40)}`).join(', ')} (or OpenVibe.Network could not be asked just now). Check the spelling and try again.` };
        }
        const allowed = wanted.length ? { subjects: resolved.subjects, usernames: resolved.names } : null;
        const expiresAt = new Date(s.now() + rules.expiryHours(hours) * 3_600_000).toISOString();
        const share = await store.insertShare(s, {
            slug: newSlug(), file_id: fileId || null, folder_id: folderId || null, owner,
            owner_username: ownerUsername, expires_at: expiresAt, allowed_subjects: allowed, created_at: nowIso(),
        });
        return { ok: true, share, unresolved: resolved.unresolved };
    }

    /** The person's own share, by slug — never somebody else's. */
    async function ownShare(owner, slug) {
        if (!rules.isSlug(slug)) return null;
        const row = await store.getShare(s, slug);
        return row && row.owner === owner ? row : null;
    }

    async function revokeShare(owner, slug) {
        const row = await ownShare(owner, slug);
        if (!row) return null;
        await store.revokeShare(s, slug, nowIso());
        return store.getShare(s, slug);
    }

    // ── Reports ─────────────────────────────────────────────

    /**
     * Record a report against a share. One per person per share; the third distinct person (or any report of illegal
     * content) suspends the share at once, which is what staff then look at.
     */
    async function report(slug, { reporter, reason, note }) {
        const share = rules.isSlug(slug) ? await store.getShare(s, slug) : null;
        if (!share) return { error: 'share.not_found' };
        if (share.owner === reporter) return { error: 'share.own' };
        if (share.revoked_at) return { error: 'share.revoked' };
        const row = await store.addReport(s, { slug, reporter, reason, note, createdAt: nowIso() });
        if (!row) return { error: 'report.duplicate' };
        const count = await store.reportCount(s, slug);
        // Suspension is counted once, when the line is crossed (share.report_count is the high-water mark before this
        // report): a share staff restored is not suspended again by the reports that were already there. Illegal
        // content is the exception — it suspends however many times it has to.
        const crossed = Number(share.report_count) < rules.SUSPEND_AT_REPORTS && count >= rules.SUSPEND_AT_REPORTS;
        const suspend = !share.suspended_at && (rules.SUSPEND_IMMEDIATELY.includes(reason) || crossed);
        if (suspend) await store.suspendShare(s, slug, nowIso());
        await store.bumpReportCount(s, slug, count);
        return { report: row, share: await store.getShare(s, slug), count, suspended: suspend };
    }

    // ── Staff ───────────────────────────────────────────────

    /** Staff: let a suspended (or reported) share work again. The reports stay on the record. */
    async function restoreShare(slug) {
        const share = rules.isSlug(slug) ? await store.getShare(s, slug) : null;
        if (!share) return { error: 'share.not_found' };
        await store.restoreShare(s, slug);
        return { share: await store.getShare(s, slug) };
    }

    /**
     * Staff: remove what a share points at. Every share of that file or folder goes, the row is soft-deleted and
     * Media is asked to delete the object — or, for a folder, each file in it, one by one.
     */
    async function removeShared(slug) {
        const share = rules.isSlug(slug) ? await store.getShare(s, slug) : null;
        if (!share) return { error: 'share.not_found' };
        if (share.file_id) {
            const file = await store.getFile(s, share.file_id);
            if (!file) return { error: 'file.not_found' };
            await store.deleteSharesForFile(s, file.id);
            await store.softDeleteFile(s, file.id, nowIso());
            const removed = await media.remove(file.object_id);
            if (!removed.ok) log.warn(`[MediaHub] Media refused to delete ${file.object_id}: ${removed.status} ${removed.code}`);
            return { kind: 'file', file, media: removed };
        }
        const files = await store.listFiles(s, share.owner, { folderId: share.folder_id, limit: 1000 });
        await store.deleteSharesForFolder(s, share.folder_id);
        for (const file of files) {
            await store.softDeleteFile(s, file.id, nowIso());
            const removed = await media.remove(file.object_id);
            if (!removed.ok) log.warn(`[MediaHub] Media refused to delete ${file.object_id}: ${removed.status} ${removed.code}`);
        }
        await store.deleteFolder(s, share.folder_id, share.owner);
        return { kind: 'folder', files };
    }

    // ── Reads the pages and the API both need (no SQL outside this module) ──
    const listFiles = (owner, opts) => store.listFiles(s, owner, opts);
    const listFolders = (owner) => store.listFolders(s, owner);
    const listShares = (owner) => store.listShares(s, owner);
    const usageDays = (owner) => store.usageFor(s, owner);
    const shareBySlug = (slug) => store.getShare(s, slug);
    const reportsFor = (slug) => store.reportsFor(s, slug);

    return {
        uploadAllowed, shareAllowed, usage, dayOf,
        recordFile, ownFile, deleteFile,
        listFiles, listFolders, listShares, usageDays, shareBySlug, reportsFor,
        ownFolder, createFolder, folderPath,
        createShare, ownShare, revokeShare,
        report, restoreShare, removeShared,
        stateOf, allowedFor, parseAllow,
    };
}

module.exports = { createService, parseAllow, allowedFor, stateOf, newSlug, dayOf, DAY_MS };
