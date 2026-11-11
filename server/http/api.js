'use strict';

/**
 * /api/v1 — OpenVibe.MediaHub's API. Every route here is a signed-in person's and nothing else's: no app, agent
 * or service token can hold, share or delete somebody's files, and no route names a capability (see CAPABILITIES
 * in ./principal.js). A write made with the session cookie must come from openvibe.download itself (same-origin).
 *
 *   GET    /ping                                  anyone   liveness
 *   GET    /files?folder_id=&limit=&before=&q=    person   your drive (one folder, the root, or every folder by name)
 *   POST   /files                                 person   start an upload: { name, size, content_type, folder_id, audience? }
 *   GET    /share-defaults/download               person   audience for new uploads
 *   PUT    /share-defaults/download               person   { audience, apply? }
 *   GET    /files/:id                             person   one of your files
 *   PATCH  /files/:id                             person   { name?, folder_id? (null = the top) }
 *   DELETE /files/:id                             person   put it in the bin (or ?forever=1: delete a binned file now)
 *   POST   /files/:id/restore                     person   take a file back out of the bin
 *   GET    /folders                               person   your folders
 *   POST   /folders                               person   make one: { name, parent_id }
 *   PATCH  /folders/:id                           person   rename it: { name }
 *   DELETE /folders/:id                           person   delete an empty one (a sync key may not)
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
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
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
    const { config, s, principal, limits, drive, uploads, syncKeys, drops, media, sharing } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    // A sync key (server/drive/syncKeys.js) acts for its owner here and nowhere else: this router is the drive's API,
    // so the key never reaches Pics, Video or the pages. Anything else goes through the shared principal.
    r.use(async (req, res, next) => {
        const header = String(req.headers.authorization || '');
        if (!header.startsWith('Bearer ovdl_') || !syncKeys) return principal.middleware(req, res, next);
        const owner = await syncKeys.resolve(header.slice(7).trim());
        if (!owner) return problem(req, res, 401, 'sync_key.invalid', 'This sync key is not valid: it was revoked or never issued. Make a new one at openvibe.download/sync.');
        req.principal = { kind: 'user', requester: owner, project: null, viaSession: false, viaSyncKey: true, username: null, role: 'user' };
        return next();
    });

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

    // ── Drops: uploads without an account (server/drive/drops.js; off until MEDIAHUB_DOWNLOAD_ANONYMOUS=1) ──
    // The session is proven by X-Drop-Token (shown when it starts), never by the caller's address.
    const dropToken = (req) => String(req.get('x-drop-token') || '');
    const dropRefused = (req, res, out) => problem(req, res, out.status || (out.code === 'upload.not_found' ? 404 : 422), out.code, out.detail);
    r.put('/drops/:id/parts/:n', limits.budget('media-hub.upload.part'), async (req, res) => {
        if (!drops || !drops.enabled()) return problem(req, res, 403, 'drop.off', 'Uploads without an account are not open yet.');
        const got = await readBody(req, rawCap(config));
        if (got.error === 'too_large') return problem(req, res, 413, 'upload.part_too_large', `A part is at most ${config.partBytes} bytes.`);
        if (got.error) return problem(req, res, 400, 'upload.interrupted', 'The part did not arrive complete.');
        const out = await drops.putPart(dropToken(req), String(req.params.id || ''), req.params.n, got.buffer);
        if (!out.ok) return dropRefused(req, res, out);
        return res.json({ part: out.part, size: out.size });
    });

    r.use(express.json({ limit: '64kb' }));

    r.post('/drops', limits.budget('media-hub.drop.start'), async (req, res) => {
        if (!drops) return problem(req, res, 403, 'drop.off', 'Uploads without an account are not open yet.');
        const b = req.body || {};
        const out = await drops.start({ ip: req.ip, name: b.name, size: b.size, contentType: b.content_type });
        if (!out.ok) return dropRefused(req, res, out);
        return res.status(201).json({
            upload: out.upload, token: out.token,
            note: 'Send each part with PUT /api/v1/drops/:id/parts/:n and the header X-Drop-Token, then POST /api/v1/drops/:id/complete.',
        });
    });

    r.get('/drops/:id', async (req, res) => {
        if (!drops || !drops.enabled()) return problem(req, res, 403, 'drop.off', 'Uploads without an account are not open yet.');
        const out = await drops.status(dropToken(req), String(req.params.id || ''));
        if (!out.ok) return dropRefused(req, res, out);
        return res.json({ upload: out.upload });
    });

    r.post('/drops/:id/complete', limits.budget('media-hub.upload.complete'), async (req, res) => {
        if (!drops || !drops.enabled()) return problem(req, res, 403, 'drop.off', 'Uploads without an account are not open yet.');
        const out = await drops.complete({ token: dropToken(req), id: String(req.params.id || '') });
        if (!out.ok) return dropRefused(req, res, out);
        const d = out.drop;
        return res.status(201).json({
            drop: { slug: d.slug, url: `${config.baseUrl}/d/${d.slug}`, name: d.name, size: Number(d.size), content_type: d.content_type, created_at: d.created_at },
            delete_key: out.deleteKey,
            delete_url: `${config.baseUrl}/d/${d.slug}/delete?key=${out.deleteKey}`,
            note: `Keep the delete link: it is shown once. The file is kept ${drops.config.idleDays} days after its last download.`,
        });
    });

    r.delete('/drops/:id', async (req, res) => {
        if (!drops || !drops.enabled()) return problem(req, res, 403, 'drop.off', 'Uploads without an account are not open yet.');
        const out = await drops.abort(dropToken(req), String(req.params.id || ''));
        if (!out.ok) return dropRefused(req, res, out);
        return res.status(204).end();
    });

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
        binned_at: row.binned_at ? new Date(row.binned_at).toISOString() : null,
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
        public: row.public === true,
    });

    // ── Liveness ────────────────────────────────────────────
    r.get('/ping', limits.reads('media-hub.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    r.get('/share-defaults/:kind', person, async (req, res) => {
        const kind = String(req.params.kind || '');
        if (kind !== 'download') return problem(req, res, 404, 'share.kind', 'No such share kind.');
        return res.json({ kind, audience: await sharing.defaultAudience(personOf(req), kind) });
    });

    r.put('/share-defaults/:kind', person, async (req, res) => {
        const kind = String(req.params.kind || '');
        const audience = String((req.body || {}).audience || '');
        if (kind !== 'download' || !['public', 'link', 'people', 'private'].includes(audience)) {
            return problem(req, res, 422, 'share.default_invalid', 'Choose Everyone, Anyone with the link, Specific people, or Only me.');
        }
        const owner = personOf(req);
        await sharing.setDefaultAudience(owner, kind, audience);
        const changed = req.body && req.body.apply === true ? await sharing.applyDefault(owner, kind, audience) : 0;
        return res.json({ kind, audience, changed });
    });

    // ── Files ───────────────────────────────────────────────
    r.get('/files', person, limits.reads('media-hub.file.read'), async (req, res) => {
        const owner = personOf(req);
        // `q` searches every folder; folder_id is ignored then. Without it, one folder (or the root) is listed.
        const q = rules.cleanText(req.query.q || '', 100);
        const folderId = req.query.folder_id ? String(req.query.folder_id) : null;
        if (!q && folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'folder.invalid', 'folder_id must be a folder id.');
        const limit = Math.min(200, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
        const before = rules.isFileId(req.query.before) ? String(req.query.before) : null;
        const rows = q ? await drive.searchFiles(owner, q, { limit }) : await drive.listFiles(owner, { folderId, limit, before });
        const folders = q ? [] : (await drive.listFolders(owner)).filter((f) => (f.parent_id || null) === folderId);
        return res.json({
            folder_id: q ? null : folderId,
            ...(q ? { q } : {}),
            folders: folders.map(wireFolder),
            files: rows.map(wireFile),
            usage: await drive.usage(owner),
            note: q ? 'Search covers every folder; files in the bin are not listed.' : 'Your files only. A file is private until you make a share link for it.',
        });
    });

    /** Start an upload. The bytes follow through PUT /uploads/:id/parts/:n (see the page's script). */
    /** A sync key's uploads are counted on their own budget (server/http/caller-limits.js). */
    const uploadBudget = (name) => {
        const plain = limits.budget(`media-hub.upload.${name}`);
        const sync = limits.budget(`media-hub.sync.upload.${name}`);
        return (req, res, next) => (req.principal.viaSyncKey ? sync : plain)(req, res, next);
    };

    r.post('/files', person, uploadBudget('start'), async (req, res) => {
        const owner = personOf(req);
        const b = req.body || {};
        const size = Number(b.size);
        const name = rules.fileName(b.name, 'file');
        const contentType = rules.normalizeType(b.content_type) || 'application/octet-stream';
        const folderId = b.folder_id ? String(b.folder_id) : null;
        if (folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'folder.invalid', 'folder_id must be a folder id.');
        if (req.principal.viaSyncKey && b.audience && b.audience !== 'private') return problem(req, res, 403, 'sync_key.not_allowed', 'A sync key cannot share a backup.');
        const perDay = req.principal.viaSyncKey ? config.quotas.syncUploadsPerDay : undefined;
        const out = await uploads.startSession({ owner, name, size, contentType, folderId, perDay, audience: req.principal.viaSyncKey ? 'private' : b.audience });
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

    r.patch('/files/:id', person, async (req, res) => {
        const b = req.body || {};
        if (b.name === undefined && b.folder_id === undefined) return problem(req, res, 422, 'file.invalid', 'Nothing to change: send a name, a folder_id, or both.');
        if (b.folder_id !== undefined && b.folder_id !== null && !rules.isFolderId(b.folder_id)) return problem(req, res, 422, 'folder.invalid', 'folder_id must be a folder id, or null for the top.');
        const out = await drive.updateFile(personOf(req), String(req.params.id || ''), {
            name: b.name,
            folderId: b.folder_id === undefined ? undefined : (b.folder_id ? String(b.folder_id) : null),
        });
        if (out.error) return problem(req, res, refused(out.error), out.error, out.detail);
        return res.json({ file: wireFile(out.file) });
    });

    r.delete('/files/:id', person, async (req, res) => {
        const id = String(req.params.id || '');
        const forever = req.query.forever === '1' || req.query.forever === 'true';
        if (forever) {
            const out = await drive.purgeFile(personOf(req), id);
            if (out.error) return problem(req, res, 404, 'file.not_found', out.detail || 'No such file in the bin.');
            return res.status(204).end();
        }
        const out = await drive.deleteFile(personOf(req), id);
        if (out.error) return problem(req, res, 404, 'file.not_found', 'No such file.');
        return res.status(204).end();
    });

    r.post('/files/:id/restore', person, async (req, res) => {
        const out = await drive.restoreFile(personOf(req), String(req.params.id || ''));
        if (out.error) return problem(req, res, 404, 'file.not_found', out.detail || 'No such file in the bin.');
        return res.json({ file: wireFile(out.file) });
    });

    // A person grants one agent access to one file; the read capability never expands that grant to a drive listing.
    r.get('/agent-grants', person, limits.reads('media-hub.file.read'), async (req, res) => {
        const fileId = req.query.file_id ? String(req.query.file_id) : null;
        if (fileId && !rules.isFileId(fileId)) return problem(req, res, 422, 'file.invalid', 'file_id must be a file id.');
        return res.json({ grants: await drive.listAgentGrants(personOf(req), fileId) });
    });

    r.post('/agent-grants', person, limits.budget('media-hub.file.grant'), async (req, res) => {
        const b = req.body || {};
        const fileId = String(b.file_id || '');
        if (!rules.isFileId(fileId)) return problem(req, res, 422, 'file.invalid', 'file_id must be a file id.');
        const out = await drive.createAgentGrant(personOf(req), { fileId, agentSubject: b.agent_subject, hours: b.hours });
        if (out.error) return problem(req, res, out.error === 'file.not_found' ? 404 : 422, out.error, 'Choose one of your files, a valid agent subject, and an expiry from 1 to 720 hours.');
        res.set('Location', `/api/v1/agent-grants/${out.grant.id}`);
        return res.status(201).json({ grant: out.grant });
    });

    r.delete('/agent-grants/:id', person, async (req, res) => {
        const out = await drive.revokeAgentGrant(personOf(req), String(req.params.id || ''));
        if (out.error) return problem(req, res, 404, 'grant.not_found', 'No such grant.');
        return res.status(204).end();
    });

    // Link workers use this read-only endpoint for job inputs. Both the capability and the owner's file grant are
    // required. Stream through Media so a provider URL never becomes the agent's durable credential.
    r.get('/agent/files/:id/content', principal.requireCapability('download.file.read'), limits.reads('media-hub.file.read'), async (req, res) => {
        const caller = req.principal;
        if (!caller || caller.kind !== 'app' || !/^agent:agt_[0-9A-HJKMNP-TV-Z]{26}$/.test(caller.requester || '')) {
            return problem(req, res, 403, 'agent.required', 'This endpoint is for an agent with download.file.read.');
        }
        const fileId = String(req.params.id || '');
        const row = rules.isFileId(fileId) ? await drive.agentFile(fileId, caller.requester) : null;
        if (!row) {
            return problem(req, res, 404, 'grant.not_found', 'No active grant for this file.');
        }
        const result = await media.bytes(row.object_id, { range: req.get('range') || null });
        if (!result.ok) return problem(req, res, result.status || 502, result.code || 'media.unreachable', result.detail || 'OpenVibe.Media could not read this file.');
        const upstream = result.res;
        res.status(result.status);
        res.set('Content-Type', row.content_type || 'application/octet-stream');
        res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
        res.set('Accept-Ranges', 'bytes');
        for (const header of ['content-length', 'content-range', 'etag', 'last-modified']) {
            const value = upstream.headers.get(header);
            if (value) res.set(header, value);
        }
        if (!upstream.body) return res.end();
        await pipeline(Readable.fromWeb(upstream.body), res);
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

    r.patch('/folders/:id', person, async (req, res) => {
        const out = await drive.renameFolder(personOf(req), String(req.params.id || ''), (req.body || {}).name);
        if (out.error) return problem(req, res, out.error === 'folder.not_found' ? 404 : out.error === 'folder.exists' ? 409 : 422, out.error, out.detail);
        return res.json({ folder: wireFolder(out.folder) });
    });

    /** A sync key backs files up: it may rename or move, but deleting a folder is the person's own call. */
    r.delete('/folders/:id', person, notSyncKey, async (req, res) => {
        const out = await drive.deleteFolder(personOf(req), String(req.params.id || ''));
        if (out.error) return problem(req, res, out.error === 'folder.not_found' ? 404 : 409, out.error, out.detail);
        return res.status(204).end();
    });

    // ── Shares ──────────────────────────────────────────────
    /** A share link is made by the person themself (signed in, or their Network token), never by a sync key. */
    function notSyncKey(req, res, next) {
        if (!req.principal.viaSyncKey) return next();
        return problem(req, res, 403, 'sync_key.not_allowed', 'A sync key backs files up; share links are made at openvibe.download.');
    }

    r.post('/shares', person, notSyncKey, limits.budget('media-hub.share.create'), async (req, res) => {
        const b = req.body || {};
        const fileId = b.file_id ? String(b.file_id) : null;
        const folderId = b.folder_id ? String(b.folder_id) : null;
        if (fileId && !rules.isFileId(fileId)) return problem(req, res, 422, 'share.invalid', 'file_id must be a file id.');
        if (folderId && !rules.isFolderId(folderId)) return problem(req, res, 422, 'share.invalid', 'folder_id must be a folder id.');
        const usernames = Array.isArray(b.usernames) ? b.usernames
            : (typeof b.usernames === 'string' && b.usernames.trim() ? b.usernames.split(/[\s,]+/) : []);
        const out = await drive.createShare(personOf(req), {
            fileId, folderId, hours: b.hours, names: usernames, ownerUsername: req.principal.username, isPublic: b.public === true,
        });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/shares/${out.share.slug}`);
        return res.status(201).json({
            share: wireShare(out.share),
            unresolved: out.unresolved,
        });
    });

    r.delete('/shares/:slug', person, notSyncKey, async (req, res) => {
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
            note: 'Media\'s own quotas are per tenant (this whole service); these numbers are per person. Bytes in the bin still count against storage until they are purged.',
        });
    });

    // ── Chunked uploads (the part PUT is mounted above the JSON parser) ──
    r.get('/uploads/:id', person, limits.reads('media-hub.upload.read'), async (req, res) => {
        const out = await uploads.status(personOf(req), String(req.params.id || ''));
        if (!out.ok) return problem(req, res, out.code === 'upload.not_found' ? 404 : 409, out.code, out.detail);
        return res.json({ upload: out.upload });
    });

    r.post('/uploads/:id/complete', person, uploadBudget('complete'), async (req, res) => {
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
