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

    /**
     * Room for one more file of `size` bytes, and for uploads not to run past the day's cap. `perDay` is a larger cap
     * for a sync key's uploads (a backup sends many files); storage stays capped the same.
     */
    async function uploadAllowed(owner, size, { perDay = config.quotas.uploadsPerDay } = {}) {
        if (!Number.isInteger(size) || size < 1) return { ok: false, code: 'file.invalid_size', detail: 'A file needs a size of at least one byte.' };
        if (size > config.quotas.maxFileBytes) {
            return { ok: false, code: 'file.too_large', detail: `One file may be at most ${rules.formatBytes(config.quotas.maxFileBytes)}. This one is ${rules.formatBytes(size)}.` };
        }
        const used = await store.storedBytes(s, owner);
        if (used + size > config.quotas.bytes) {
            return { ok: false, code: 'file.quota', detail: `Your drive holds ${rules.formatBytes(used)} of ${rules.formatBytes(config.quotas.bytes)}. This file needs ${rules.formatBytes(size)} more; delete something first.` };
        }
        const today = await store.uploadsToday(s, owner, dayOf(s.now()));
        if (today >= perDay) {
            return { ok: false, code: 'file.daily_limit', detail: `You have uploaded ${perDay} files today (the most one person may). Try again tomorrow.` };
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

    /** One of the person's own live files, or null. A file is private: nobody else's id resolves here. */
    const ownFile = async (owner, id) => {
        if (!rules.isFileId(id)) return null;
        const row = await store.getFile(s, id);
        return row && row.owner === owner && !row.deleted_at && !row.binned_at ? row : null;
    };

    /** One of the person's own files in the bin, or null. */
    const ownBinnedFile = async (owner, id) => {
        if (!rules.isFileId(id)) return null;
        const row = await store.getFile(s, id);
        return row && row.owner === owner && !row.deleted_at && row.binned_at ? row : null;
    };

    /**
     * Delete a file: its share links go at once, and the row goes to the bin for 30 days. The bytes stay in Media
     * until the due purge takes it, so a restore costs nothing. A binned row still counts against storage.
     */
    async function deleteFile(owner, id) {
        const row = await ownFile(owner, id);
        if (!row) return { error: 'file.not_found' };
        await store.deleteSharesForFile(s, id);
        await store.revokeGrantsForFile(s, id, nowIso());
        await store.binFile(s, id, nowIso());
        return { file: await store.getFile(s, id) };
    }

    /** Put a binned file back in the drive. Its share links are gone for good; its folder may be too. */
    async function restoreFile(owner, id) {
        const row = await ownBinnedFile(owner, id);
        if (!row) return { error: 'file.not_found', detail: 'No such file in the bin.' };
        await store.restoreFile(s, id);
        // The folder may have been deleted while the file sat in the bin; put it back at the top rather than nowhere.
        if (row.folder_id && !await store.getFolder(s, row.folder_id)) await store.moveFile(s, id, owner, null);
        return { file: await store.getFile(s, id) };
    }

    /** What deleteFile did before the bin: the shares go, the row is soft-deleted and Media is asked for the object. */
    async function hardDelete(row) {
        await store.deleteSharesForFile(s, row.id);
        await store.revokeGrantsForFile(s, row.id, nowIso());
        await store.softDeleteFile(s, row.id, nowIso());
        const removed = await media.remove(row.object_id);
        if (!removed.ok) log.warn(`[MediaHub] Media refused to delete ${row.object_id}: ${removed.status} ${removed.code}`);
        return { file: row, media: removed };
    }

    /** Give one agent read access to one of this person's files for a bounded period. */
    async function createAgentGrant(owner, { fileId, agentSubject, hours = 24 }) {
        const file = await ownFile(owner, fileId);
        if (!file) return { error: 'file.not_found' };
        if (!/^agent:agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(agentSubject || ''))) return { error: 'agent.invalid' };
        const ttl = Number(hours);
        if (!Number.isInteger(ttl) || ttl < 1 || ttl > 720) return { error: 'grant.invalid_expiry' };
        const createdAt = nowIso();
        return { grant: await store.insertAgentGrant(s, {
            id: s.newId('agr'), owner, file_id: file.id, agent_subject: agentSubject,
            created_at: createdAt, expires_at: new Date(Date.parse(createdAt) + ttl * 60 * 60 * 1000).toISOString(),
        }) };
    }

    async function revokeAgentGrant(owner, id) {
        const row = await store.getAgentGrant(s, id);
        if (!row || row.owner !== owner) return { error: 'grant.not_found' };
        await store.revokeAgentGrant(s, id, owner, nowIso());
        return { grant: await store.getAgentGrant(s, id) };
    }

    const listAgentGrants = (owner, fileId = null) => store.listAgentGrants(s, owner, fileId);
    const activeAgentGrant = (fileId, agentSubject) => store.activeAgentGrant(s, fileId, agentSubject, nowIso());
    async function agentFile(fileId, agentSubject) {
        const grant = await activeAgentGrant(fileId, agentSubject);
        if (!grant) return null;
        const row = await store.getFile(s, fileId);
        return row && !row.deleted_at && !row.binned_at ? row : null;
    }

    /** Delete one binned file forever. Only a file already in the bin resolves here. */
    async function purgeFile(owner, id) {
        const row = await ownBinnedFile(owner, id);
        if (!row) return { error: 'file.not_found', detail: 'No such file in the bin.' };
        return hardDelete(row);
    }

    /** Empty this person's bin, a batch at a time. */
    async function emptyBin(owner, { batch = 200 } = {}) {
        let total = 0;
        for (;;) {
            const rows = await store.listBinned(s, owner, { limit: batch });
            if (!rows.length) return total;
            for (const row of rows) await hardDelete(row);
            total += rows.length;
            if (rows.length < batch) return total;
        }
    }

    /**
     * The due purge: every file binned more than BIN_DAYS ago is deleted forever, in batches of `batch` (the job asks
     * for 200). Returns how many went. The clock is the store's, so a test can move it.
     */
    async function purgeDue({ batch = 200 } = {}) {
        const cutoff = new Date(s.now() - rules.BIN_DAYS * DAY_MS).toISOString();
        let total = 0;
        for (;;) {
            const rows = await store.dueBinned(s, cutoff, batch);
            if (!rows.length) return total;
            for (const row of rows) await hardDelete(row);
            total += rows.length;
            if (rows.length < batch) return total;
        }
    }

    /** Rename one of the person's files. The name follows the same rule as an upload's. */
    async function renameFile(owner, id, name) {
        const row = await ownFile(owner, id);
        if (!row) return { error: 'file.not_found' };
        const clean = rules.cleanName(name);
        if (!clean) return { error: 'file.invalid_name', detail: 'A file needs a name.' };
        await store.renameFile(s, row.id, owner, clean);
        return { file: await store.getFile(s, row.id) };
    }

    /** Move one of the person's files into one of their folders, or to the root (folderId null). */
    async function moveFile(owner, id, folderId = null) {
        const row = await ownFile(owner, id);
        if (!row) return { error: 'file.not_found' };
        if (folderId && !await ownFolder(owner, folderId)) return { error: 'folder.not_found', detail: 'That folder does not exist.' };
        await store.moveFile(s, row.id, owner, folderId || null);
        return { file: await store.getFile(s, row.id) };
    }

    /**
     * The API's PATCH /files/:id: a new name and/or a new folder, in one write. An absent field is left alone; a
     * folder_id of null moves the file to the top.
     */
    async function updateFile(owner, id, { name, folderId } = {}) {
        const row = await ownFile(owner, id);
        if (!row) return { error: 'file.not_found' };
        let clean = row.name;
        if (name !== undefined) {
            clean = rules.cleanName(name);
            if (!clean) return { error: 'file.invalid_name', detail: 'A file needs a name.' };
        }
        let target = row.folder_id || null;
        if (folderId !== undefined) {
            if (folderId && !await ownFolder(owner, folderId)) return { error: 'folder.not_found', detail: 'That folder does not exist.' };
            target = folderId || null;
        }
        await store.updateFile(s, row.id, owner, { name: clean, folderId: target });
        return { file: await store.getFile(s, row.id) };
    }

    /** The person's files whose names hold the words, from every folder. */
    const searchFiles = (owner, words, opts) => {
        const clean = rules.cleanText(words, 100);
        return clean ? store.searchFiles(s, owner, clean, opts) : Promise.resolve([]);
    };

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

    /** Rename a folder; two folders in one place still never share a name. */
    async function renameFolder(owner, id, name) {
        const folder = await ownFolder(owner, id);
        if (!folder) return { error: 'folder.not_found', detail: 'That folder does not exist.' };
        const clean = rules.cleanName(name, rules.FOLDER_NAME_MAX);
        if (!clean) return { error: 'folder.invalid_name', detail: 'A folder needs a name.' };
        const existing = await store.listFolders(s, owner);
        if (existing.some((f) => f.id !== folder.id && (f.parent_id || null) === (folder.parent_id || null) && f.name.toLowerCase() === clean.toLowerCase())) {
            return { error: 'folder.exists', detail: `You already have a folder called "${clean}" here.` };
        }
        await store.renameFolder(s, folder.id, owner, clean);
        return { folder: await store.getFolder(s, folder.id) };
    }

    /**
     * Delete an empty folder. A folder that still holds something is refused rather than emptied: a file in the bin
     * is already out of the folder, so an emptied folder can go and a restore puts the file back at the top.
     */
    async function deleteFolder(owner, id) {
        const folder = await ownFolder(owner, id);
        if (!folder) return { error: 'folder.not_found', detail: 'That folder does not exist.' };
        if (await store.folderInUse(s, folder.id)) return { error: 'folder.not_empty', detail: `"${folder.name}" still has files or folders in it. Move or delete them first.` };
        await store.deleteSharesForFolder(s, folder.id);
        await store.deleteFolder(s, folder.id, owner);
        return { folder };
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
    async function createShare(owner, { fileId = null, folderId = null, hours, names = [], ownerUsername = null, isPublic = false }) {
        const room = await shareAllowed(owner);
        if (!room.ok) return room;
        if (fileId && !await ownFile(owner, fileId)) return { ok: false, code: 'file.not_found', detail: 'No such file.' };
        if (folderId && !await ownFolder(owner, folderId)) return { ok: false, code: 'folder.not_found', detail: 'No such folder.' };
        if (!fileId && !folderId) return { ok: false, code: 'share.invalid', detail: 'A share names one file or one folder.' };
        if (fileId && folderId) return { ok: false, code: 'share.invalid', detail: 'A share names one file or one folder, not both.' };
        const wanted = [...new Set(names.map((n) => String(n || '').trim().toLowerCase()).filter(Boolean))];
        if (isPublic && wanted.length) return { ok: false, code: 'share.invalid', detail: 'A public link is for anyone with it, so it cannot also name accounts. Choose one.' };
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
            owner_username: ownerUsername, expires_at: expiresAt, allowed_subjects: allowed, created_at: nowIso(), public: isPublic === true,
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
            const out = await hardDelete(file);
            return { kind: 'file', ...out };
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
    /** Read-only source records from Pics and Video in the same MediaHub database; bytes remain with each product. */
    async function listSourceFiles(owner, { query = '', include = true } = {}) {
        if (!include) return [];
        const q = String(query || '').trim();
        const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
        const [pictures, videos] = await Promise.all([
            s.db.many(
                `SELECT id, slug, title, object_id, mime_type AS content_type, bytes AS size, created_at
                   FROM pics_images WHERE owner = $1 AND state IN ('active', 'hidden')
                    AND ($2::text IS NULL OR title ILIKE $2 ESCAPE '\\' OR slug ILIKE $2 ESCAPE '\\')
                  ORDER BY id DESC LIMIT 200`, [owner, like]),
            s.db.many(
                `SELECT id, title, media_vod_id, content_type, size_bytes AS size, created_at
                   FROM video_uploads WHERE owner = $1 AND state <> 'removed' AND status = 'ready' AND media_vod_id IS NOT NULL
                    AND ($2::text IS NULL OR title ILIKE $2 ESCAPE '\\' OR id ILIKE $2 ESCAPE '\\')
                  ORDER BY id DESC LIMIT 200`, [owner, like]),
        ]);
        return [
            ...pictures.map((row) => ({ ...row, name: String(row.title || '').trim() || `Picture ${row.slug}`, source: 'pics', source_label: 'OpenVibe.Pics', source_url: `${config.pics.url}/i/${encodeURIComponent(row.slug)}` })),
            ...videos.map((row) => ({ ...row, name: String(row.title || '').trim() || 'Video', source: 'video', source_label: 'OpenVibe.Video', source_url: `${config.video.url}/u/${encodeURIComponent(row.id)}` })),
        ];
    }
    const listBinned = (owner, opts) => store.listBinned(s, owner, opts);
    const binCount = (owner) => store.countBinned(s, owner);
    const listFolders = (owner) => store.listFolders(s, owner);
    const listShares = (owner) => store.listShares(s, owner);
    const usageDays = (owner) => store.usageFor(s, owner);
    const shareBySlug = (slug) => store.getShare(s, slug);
    const reportsFor = (slug) => store.reportsFor(s, slug);

    return {
        uploadAllowed, shareAllowed, usage, dayOf,
        recordFile, ownFile, ownBinnedFile, deleteFile, restoreFile, purgeFile, purgeDue, emptyBin, updateFile,
        renameFile, moveFile, searchFiles,
        listFiles, listSourceFiles, listBinned, binCount, listFolders, listShares, usageDays, shareBySlug, reportsFor,
        ownFolder, createFolder, renameFolder, deleteFolder, folderPath,
        createShare, ownShare, revokeShare,
        createAgentGrant, revokeAgentGrant, listAgentGrants, activeAgentGrant, agentFile,
        report, restoreShare, removeShared,
        stateOf, allowedFor, parseAllow,
    };
}

module.exports = { createService, parseAllow, allowedFor, stateOf, newSlug, dayOf, DAY_MS };
