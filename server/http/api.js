'use strict';

/**
 * /api/v1 — OpenVibe.MediaHub's API. Every route here is a signed-in person's and nothing else's: no app, agent
 * or service token can hold, share or delete somebody's files, and no route names a capability (see CAPABILITIES
 * in ./principal.js). A write made with the session cookie must come from openvibe.download itself (same-origin).
 *
 *   GET    /ping                                  anyone   liveness
 *   GET    /files?folder_id=&limit=&before=       person   your drive (one folder, or the root)
 *   POST   /files                                 person   start an upload: { name, size, content_type, folder_id }
 *   GET    /files/:id                             person   one of your files
 *   DELETE /files/:id                             person   delete it (and ask Media to delete the object)
 *   GET    /folders                               person   your folders
 *   POST   /folders                               person   make one: { name, parent_id }
 *   POST   /shares                                person   share a file or a folder: { file_id|folder_id, hours, usernames }
 *   DELETE /shares/:slug                          person   revoke one
 *   GET    /usage                                 person   what you hold and what is left
 *   PUT    /uploads/:id/parts/:n                  person   one part of a chunked upload (the raw bytes)
 *   GET    /uploads/:id                           person   what is still missing (resume)
 *   POST   /uploads/:id/complete                  person   assemble it into a file
 *   DELETE /uploads/:id                           person   abandon it
 *
 * A refusal is an RFC 9457 problem+json with a stable code. The product's own caps (2 GB, 512 MB a file, 50
 * uploads a day, 20 live shares) are `file.quota` / `file.too_large` / `file.daily_limit` / `share.limit` — told
 * apart from the rate limiter's `rate_limited`, and answered before anything is written.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const rules = require('../drive/rules');

/** The largest single part body we will read, plus room for a stray byte the length check must then refuse. */
const rawCap = (config) => config.partBytes + 1024;

/** Read a raw request body, refusing past `cap` bytes. */
function readBody(req, cap) {
    return new Promise((resolve) => {
        const chunks = [];
        let total = 0;
        let done = false;
        const settle = (v) => { if (!done) { done = true; resolve(v); } };
        req.on('data', (c) => {
            total += c.length;
            if (total > cap) { req.resume(); return settle({ error: 'too_large' }); }
            chunks.push(c);
        });
        req.on('end', () => settle({ buffer: Buffer.concat(chunks) }));
        req.on('aborted', () => settle({ error: 'aborted' }));
        req.on('error', () => settle({ error: 'aborted' }));
    });
}

function createApi(ctx) {
    const { config, s, principal, limits, drive, uploads } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    // openvibe.pics and openvibe.video have no API: no upload, no drive, no share links (server/brand.js).
    r.use((req, res, next) => (req.brand && req.brand !== 'download'
        ? contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'This brand of the hub has no API yet; OpenVibe.Download is the one that has launched.', ctx: req.ov })
        : next()));
    r.use(principal.middleware);

    /**
     * The chunked upload's part body is raw bytes, so it is mounted before the JSON parser: express must never try
     * to read a megabyte of file as JSON. Everything below the parser is JSON in, JSON out.
     */
    r.put('/uploads/:id/parts/:n', person, limits.budget('media-hub.upload.part'), async (req, res) => {
        const got = await readBody(req, rawCap(config));
        if (got.error === 'too_large') return problem(req, res, 413, 'upload.part_too_large', `A part is at most ${config.partBytes} bytes.`);
        if (got.error) return problem(req, res, 400, 'upload.interrupted', 'The part did not arrive complete.');
        const out = await uploads.putPart(personOf(req), String(req.params.id || ''), req.params.n, got.buffer);
        if (!out.ok) return problem(req, res, out.code === 'upload.not_found' ? 404 : 422, out.code, out.detail);
        return res.json({ part: out.part, size: out.size });
    });

    r.use(express.json({ limit: '64kb' }));

    const personOf = (req) => (req.principal.kind === 'user' ? req.principal.requester : null);

    /**
     * The HTTP status a product refusal is answered with. A cap (too large, quota, a day's uploads, too many live
     * shares) is 429 or 413; something that is not there is 404; everything else is a 422 the caller can fix.
     */
    function refused(code) {
        if (String(code).startsWith('media.')) return 502;      // OpenVibe.Media refused or could not be reached
        if (code === 'file.not_found' || code === 'folder.not_found' || code === 'share.not_found') return 404;
        if (code === 'file.too_large') return 413;
        if (code === 'file.quota' || code === 'file.daily_limit' || code === 'share.limit') return 429;
        return 422;
    }

    // ── Who may act ─────────────────────────────────────────
    /**
     * A person, signed in. An app, agent or service token is refused: a file is somebody's own, and no app holds
     * one here. A session write must come from openvibe.download itself.
     */
    function requirePerson(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') {
            problem(req, res, 401, 'token.required', 'Sign in at openvibe.download, or send a person\'s Network token as a Bearer.');
            return false;
        }
        if (p.kind !== 'user') {
            problem(req, res, 403, 'file.person_required', 'Files, folders and share links belong to a person; an app, agent or service token cannot hold or share them.');
            return false;
        }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.download itself.');
            return false;
        }
        return true;
    }
    // Declared before the routes that use it: the raw part route is mounted above the JSON parser.
    function person(req, res, next) { return requirePerson(req, res) ? next() : undefined; }

    // ── Wire shapes ─────────────────────────────────────────
    const wireFile = (row) => ({
        id: row.id, name: row.name, size: Number(row.size), content_type: row.content_type,
        sha256: row.sha256, folder_id: row.folder_id, created_at: row.created_at,
        object: { media_object_id: row.object_id },
    });
    const wireFolder = (row) => ({ id: row.id, name: row.name, parent_id: row.parent_id, created_at: row.created_at });
    const wireShare = (row) => ({
        slug: row.slug, url: `/s/${row.slug}`,
        file_id: row.file_id, folder_id: row.folder_id,
        expires_at: row.expires_at, downloads: Number(row.downloads) || 0, report_count: Number(row.report_count) || 0,
        state: drive.stateOf(row, s.iso()),
        revoked_at: row.revoked_at, suspended_at: row.suspended_at, created_at: row.created_at,
        allowed: drive.parseAllow(row.allowed_subjects),
        limited: Boolean(row.allowed_subjects),
    });

    // ── Liveness ────────────────────────────────────────────
    r.get('/ping', limits.reads('media-hub.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    // ── Files ───────────────────────────────────────────────
    r.get('/files', person, limits.reads('media-hub.file.read'), async (req, res) => {
        const owner = personOf(req);
        const folderId = req.query.folder_id ? String(req.query.folder_id) : null;
        if (folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'folder.invalid', 'folder_id must be a folder id.');
        const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
        const before = rules.isFileId(req.query.before) ? String(req.query.before) : null;
        const rows = await drive.listFiles(owner, { folderId, limit, before });
        const folders = await drive.listFolders(owner);
        return res.json({
            folder_id: folderId,
            folders: folders.filter((f) => (f.parent_id || null) === folderId).map(wireFolder),
            files: rows.map(wireFile),
            usage: await drive.usage(owner),
            note: 'Your files only. A file is private until you make a share link for it.',
        });
    });

    /** Start an upload. The bytes follow through PUT /uploads/:id/parts/:n (see the page's script). */
    r.post('/files', person, limits.budget('media-hub.upload.start'), async (req, res) => {
        const owner = personOf(req);
        const b = req.body || {};
        const size = Number(b.size);
        const name = rules.fileName(b.name, 'file');
        const contentType = rules.normalizeType(b.content_type) || 'application/octet-stream';
        const folderId = b.folder_id ? String(b.folder_id) : null;
        if (folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'folder.invalid', 'folder_id must be a folder id.');
        const out = await uploads.startSession({ owner, name, size, contentType, folderId });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/uploads/${out.upload.id}`);
        return res.status(201).json({
            upload: out.upload,
            note: 'Send each part of `missing` (they are part_size bytes, the last one less) with PUT /api/v1/uploads/:id/parts/:n, then POST /api/v1/uploads/:id/complete.',
        });
    });

    r.get('/files/:id', person, limits.reads('media-hub.file.read'), async (req, res) => {
        const row = await drive.ownFile(personOf(req), String(req.params.id || ''));
        if (!row) return problem(req, res, 404, 'file.not_found', 'No such file.');
        return res.json({ file: wireFile(row), shares: (await drive.listShares(row.owner)).filter((x) => x.file_id === row.id).map(wireShare) });
    });

    r.delete('/files/:id', person, async (req, res) => {
        const out = await drive.deleteFile(personOf(req), String(req.params.id || ''));
        if (out.error) return problem(req, res, 404, 'file.not_found', 'No such file.');
        return res.status(204).end();
    });

    // ── Folders ─────────────────────────────────────────────
    r.get('/folders', person, limits.reads('media-hub.folder.read'), async (req, res) => {
        const rows = await drive.listFolders(personOf(req));
        return res.json({ folders: rows.map(wireFolder) });
    });

    r.post('/folders', person, limits.budget('media-hub.folder.create'), async (req, res) => {
        const b = req.body || {};
        const parentId = b.parent_id ? String(b.parent_id) : null;
        if (parentId && !rules.isFolderId(parentId)) return problem(req, res, 422, 'folder.invalid', 'parent_id must be a folder id.');
        const out = await drive.createFolder(personOf(req), { name: b.name, parentId });
        if (out.error) return problem(req, res, out.error === 'folder.exists' ? 409 : 422, out.error, out.detail);
        res.set('Location', `/api/v1/folders/${out.folder.id}`);
        return res.status(201).json({ folder: wireFolder(out.folder) });
    });

    // ── Shares ──────────────────────────────────────────────
    r.post('/shares', person, limits.budget('media-hub.share.create'), async (req, res) => {
        const b = req.body || {};
        const fileId = b.file_id ? String(b.file_id) : null;
        const folderId = b.folder_id ? String(b.folder_id) : null;
        if (fileId && !rules.isFileId(fileId)) return problem(req, res, 422, 'share.invalid', 'file_id must be a file id.');
        if (folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'share.invalid', 'folder_id must be a folder id.');
        const usernames = Array.isArray(b.usernames) ? b.usernames
            : (typeof b.usernames === 'string' && b.usernames.trim() ? b.usernames.split(/[\s,]+/) : []);
        const out = await drive.createShare(personOf(req), {
            fileId, folderId, hours: b.hours, names: usernames, ownerUsername: req.principal.username,
        });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/shares/${out.share.slug}`);
        return res.status(201).json({
            share: wireShare(out.share),
            unresolved: out.unresolved,
            note: (out.unresolved || []).length
                ? 'Network could not turn these names into subjects; the share still allows them by their username claim.'
                : undefined,
        });
    });

    r.delete('/shares/:slug', person, async (req, res) => {
        const row = await drive.revokeShare(personOf(req), String(req.params.slug || ''));
        if (!row) return problem(req, res, 404, 'share.not_found', 'No such share.');
        return res.status(204).end();
    });

    // ── Usage ───────────────────────────────────────────────
    r.get('/usage', person, limits.reads('media-hub.usage.read'), async (req, res) => {
        const owner = personOf(req);
        return res.json({
            usage: await drive.usage(owner),
            days: (await drive.usageDays(owner)).map((d) => ({ day: d.day, uploads: Number(d.uploads) })),
            note: 'Media\'s own quotas are per tenant (this whole service); these numbers are per person.',
        });
    });

    // ── Chunked uploads (the part PUT is mounted above the JSON parser) ──
    r.get('/uploads/:id', person, limits.reads('media-hub.upload.read'), async (req, res) => {
        const out = await uploads.status(personOf(req), String(req.params.id || ''));
        if (!out.ok) return problem(req, res, out.code === 'upload.not_found' ? 404 : 409, out.code, out.detail);
        return res.json({ upload: out.upload });
    });

    r.post('/uploads/:id/complete', person, limits.budget('media-hub.upload.complete'), async (req, res) => {
        const out = await uploads.complete(personOf(req), String(req.params.id || ''));
        if (!out.ok) {
            const status = out.code === 'upload.not_found' ? 404 : (out.code === 'file.quota' ? 429 : 409);
            return problem(req, res, status, out.code, out.detail);
        }
        res.set('Location', `/api/v1/files/${out.file.id}`);
        return res.status(201).json({ file: wireFile(out.file) });
    });

    r.delete('/uploads/:id', person, async (req, res) => {
        const out = await uploads.abort(personOf(req), String(req.params.id || ''));
        if (!out.ok) return problem(req, res, 404, 'upload.not_found', 'No such upload.');
        return res.status(204).end();
    });

    return r;
}

module.exports = { createApi, readBody };
