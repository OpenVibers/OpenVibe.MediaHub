'use strict';

/**
 * /api/v1/video — the playlist API on openvibe.video (step C, plan T10). It is mounted only on the video host,
 * inside createVideoRoutes, so the drive's /api/v1 stays exactly as it is. The caller is the existing
 * principal (server/http/principal.js): a person's own Network token works like the session, an app, agent or
 * service token needs the capability the route names, and a signed-out browser may read public playlists.
 *
 *   GET    /api/v1/video/playlists                       the caller's own playlists (person, or app with read)
 *   POST   /api/v1/video/playlists                       make one: { title, description?, visibility? } (person, or app with manage)
 *   GET    /api/v1/video/playlists/:id                   one playlist: the owner sees private too; public/unlisted open to all, private answers 404
 *   PATCH  /api/v1/video/playlists/:id                   rename / describe / change visibility (owner; app with manage)
 *   DELETE /api/v1/video/playlists/:id                   delete it (its items go with it) (owner; app with manage)
 *   POST   /api/v1/video/playlists/:id/items             add one: { kind: 'vod'|'clip', id } (owner; app with manage)
 *   PATCH  /api/v1/video/playlists/:id/items             reorder: the full ordered list { items: [{ kind, id }, …] } (owner; app with manage)
 *   DELETE /api/v1/video/playlists/:id/items/:kind/:itemId   remove one (owner; app with manage)
 *   GET    /api/v1/video/users/:username/playlists       a person's public playlists, newest first, paged by cursor
 *
 * An app owns a playlist under its requester (app:app_…, agent:agt_…, service:<slug>) and records its project.
 * A refusal is an RFC 9457 problem+json with a stable code, in the repo's own style.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');
const { USERNAME_RE } = require('./live-client');

function createVideoApiRoutes(ctx) {
    const { config, playlists, principal, limits, identity } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });
    const videoSite = 'openvibe.video';

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.MEDIAHUB_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    r.use(principal.middleware);
    r.use(express.json({ limit: '64kb' }));

    const read = principal.requireCapability('video.playlist.read', { origin: config.video.url, site: videoSite });
    const manage = principal.requireCapability('video.playlist.manage', { origin: config.video.url, site: videoSite });

    /** The owner string this principal acts as, or null for a signed-out caller. */
    const requesterOf = (req) => {
        const p = req.principal;
        return (p && (p.kind === 'user' || p.kind === 'app') && p.requester) ? p.requester : null;
    };

    function refused(code) {
        if (code === 'playlist.not_found' || code === 'playlist.item_not_found') return 404;
        if (code === 'playlist.item_duplicate') return 409;
        return 422;
    }

    const wirePlaylist = (row, itemCount = null) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        visibility: row.visibility,
        item_count: Number(itemCount == null ? (row.item_count != null ? row.item_count : 0) : itemCount),
        created_at: row.created_at,
        updated_at: row.updated_at,
    });
    const wireItem = (row) => ({ kind: row.kind, id: Number(row.item_id), position: Number(row.position), added_at: row.added_at });
    const wireOwner = (row) => {
        const owner = String(row.owner || '');
        if (owner.startsWith('user:')) return { kind: 'user', username: row.owner_username || null };
        const kind = owner.split(':')[0];
        return { kind: kind === 'agent' || kind === 'service' ? kind : 'app' };
    };

    r.get('/playlists', read, limits.reads('media-hub.playlist.read'), async (req, res) => {
        const rows = await playlists.list(requesterOf(req));
        if (req.principal.kind === 'user' && req.principal.username) await playlists.refreshOwnerUsername(requesterOf(req), req.principal.username);
        return res.json({ playlists: rows.map(wirePlaylist) });
    });

    r.post('/playlists', manage, limits.budget('media-hub.playlist.create'), async (req, res) => {
        const b = req.body || {};
        const p = req.principal;
        const out = await playlists.create(requesterOf(req), {
            title: b.title, description: b.description, visibility: b.visibility,
            ownerUsername: p.kind === 'user' ? p.username : null,
            projectId: p.kind === 'app' ? p.project : null,
        });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/video/playlists/${out.playlist.id}`);
        return res.status(201).json({ playlist: wirePlaylist(out.playlist, 0) });
    });

    r.get('/playlists/:id', limits.reads('media-hub.playlist.read'), async (req, res) => {
        const row = await playlists.get(String(req.params.id || ''));
        if (!row) return problem(req, res, 404, 'playlist.not_found', 'No such playlist.');
        const owner = requesterOf(req);
        const isOwner = owner != null && owner === row.owner;
        const isPublic = row.visibility === 'public' || row.visibility === 'unlisted';

        if (isOwner) {
            const items = await playlists.items(row.id);
            return res.json({ playlist: { ...wirePlaylist(row, items.length), owner: wireOwner(row) }, items: items.map(wireItem) });
        }
        // A private playlist answers 404 to everyone but its owner: never reveal that it exists.
        if (!isPublic) return problem(req, res, 404, 'playlist.not_found', 'No such playlist.');
        if (req.principal.kind === 'app') {
            const decision = contracts.capabilities.check(req.principal.claims, 'video.playlist.read');
            if (!decision.allowed) return problem(req, res, 403, decision.code || 'capability.denied', decision.reason || 'video.playlist.read not granted');
        }

        const items = await playlists.items(row.id);
        return res.json({ playlist: { ...wirePlaylist(row, items.length), owner: wireOwner(row) }, items: items.map(wireItem) });
    });

    r.patch('/playlists/:id', manage, limits.budget('media-hub.playlist.write'), async (req, res) => {
        const out = await playlists.update(requesterOf(req), String(req.params.id || ''), req.body || {});
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.json({ playlist: wirePlaylist(out.playlist) });
    });

    r.delete('/playlists/:id', manage, limits.budget('media-hub.playlist.write'), async (req, res) => {
        const out = await playlists.remove(requesterOf(req), String(req.params.id || ''));
        if (!out.ok) return problem(req, res, 404, 'playlist.not_found', 'No such playlist.');
        return res.status(204).end();
    });

    r.post('/playlists/:id/items', manage, limits.budget('media-hub.playlist.write'), async (req, res) => {
        const b = req.body || {};
        const out = await playlists.addItem(requesterOf(req), String(req.params.id || ''), { kind: b.kind, id: b.id });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/video/playlists/${req.params.id}/items/${out.item.kind}/${out.item.item_id}`);
        return res.status(201).json({ item: wireItem(out.item) });
    });

    r.patch('/playlists/:id/items', manage, limits.budget('media-hub.playlist.write'), async (req, res) => {
        const list = Array.isArray(req.body) ? req.body : (req.body && req.body.items);
        const out = await playlists.reorder(requesterOf(req), String(req.params.id || ''), list);
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.json({ items: out.items.map(wireItem) });
    });

    r.delete('/playlists/:id/items/:kind/:itemId', manage, limits.budget('media-hub.playlist.write'), async (req, res) => {
        const out = await playlists.removeItem(requesterOf(req), String(req.params.id || ''), String(req.params.kind || ''), req.params.itemId);
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.status(204).end();
    });

    r.get('/users/:username/playlists', limits.reads('media-hub.playlist.read'), async (req, res) => {
        const username = String(req.params.username || '');
        if (!USERNAME_RE.test(username)) return problem(req, res, 404, 'user.not_found', 'No such OpenVibe user.');
        const subject = await identity.resolveUsername(username);
        if (!subject) return problem(req, res, 404, 'user.not_found', 'No such OpenVibe user.');
        const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        const cursor = req.query.cursor ? String(req.query.cursor) : null;
        const out = await playlists.publicByOwner(`user:${subject}`, { limit, cursor });
        return res.json({ playlists: out.playlists.map(wirePlaylist), next_cursor: out.next });
    });

    return r;
}

module.exports = { createVideoApiRoutes };
