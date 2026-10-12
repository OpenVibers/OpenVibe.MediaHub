'use strict';

/**
 * /api/v1/video/playlists — the playlist API on openvibe.video (step C). It is mounted only on the video host,
 * inside createVideoRoutes, so the drive's /api/v1 stays exactly as it is. For now it is a browser-session API:
 * the owner is the signed-in person (req.viewer), never an app, agent or service token, and a write made with the
 * session cookie must come from openvibe.video itself (same-origin), exactly as in the drive.
 *
 *   GET    /api/v1/video/playlists                       the person's playlists
 *   POST   /api/v1/video/playlists                       make one: { title, description?, visibility? }
 *   GET    /api/v1/video/playlists/:id                   one playlist and its items (owner only)
 *   PATCH  /api/v1/video/playlists/:id                   rename / describe / change visibility
 *   DELETE /api/v1/video/playlists/:id                   delete it (its items go with it)
 *   POST   /api/v1/video/playlists/:id/items             add one: { kind: 'vod'|'clip', id }
 *   PATCH  /api/v1/video/playlists/:id/items             reorder: the full ordered list { items: [{ kind, id }, …] }
 *   DELETE /api/v1/video/playlists/:id/items/:kind/:itemId   remove one
 *
 * A refusal is an RFC 9457 problem+json with a stable code, in the repo's own style.
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');

function createVideoApiRoutes(ctx) {
    const { config, playlists } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(express.json({ limit: '64kb' }));

    const ownerOf = (req) => (req.viewer && req.viewer.kind === 'user' && req.viewer.subject ? `user:${req.viewer.subject}` : null);

    /** A signed-in person; a write by session cookie must be same-origin. */
    function person(req, res, next) {
        const owner = ownerOf(req);
        if (!owner) {
            problem(req, res, 401, 'token.required', 'Sign in to openvibe.video to manage your playlists.');
            return undefined;
        }
        if (req.method !== 'GET' && !sameOrigin(req, config.video.url)) {
            problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.video itself.');
            return undefined;
        }
        req.playlistOwner = owner;
        return next();
    }

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

    r.get('/', person, async (req, res) => {
        const rows = await playlists.list(req.playlistOwner);
        return res.json({ playlists: rows.map(wirePlaylist) });
    });

    r.post('/', person, async (req, res) => {
        const b = req.body || {};
        const out = await playlists.create(req.playlistOwner, { title: b.title, description: b.description, visibility: b.visibility });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/video/playlists/${out.playlist.id}`);
        return res.status(201).json({ playlist: wirePlaylist(out.playlist, 0) });
    });

    r.get('/:id', person, async (req, res) => {
        const row = await playlists.own(req.playlistOwner, String(req.params.id || ''));
        if (!row) return problem(req, res, 404, 'playlist.not_found', 'No such playlist.');
        const items = await playlists.items(row.id);
        return res.json({ playlist: wirePlaylist(row, items.length), items: items.map(wireItem) });
    });

    r.patch('/:id', person, async (req, res) => {
        const out = await playlists.update(req.playlistOwner, String(req.params.id || ''), req.body || {});
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.json({ playlist: wirePlaylist(out.playlist) });
    });

    r.delete('/:id', person, async (req, res) => {
        const out = await playlists.remove(req.playlistOwner, String(req.params.id || ''));
        if (!out.ok) return problem(req, res, 404, 'playlist.not_found', 'No such playlist.');
        return res.status(204).end();
    });

    r.post('/:id/items', person, async (req, res) => {
        const b = req.body || {};
        const out = await playlists.addItem(req.playlistOwner, String(req.params.id || ''), { kind: b.kind, id: b.id });
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        res.set('Location', `/api/v1/video/playlists/${req.params.id}/items/${out.item.kind}/${out.item.item_id}`);
        return res.status(201).json({ item: wireItem(out.item) });
    });

    r.patch('/:id/items', person, async (req, res) => {
        const list = Array.isArray(req.body) ? req.body : (req.body && req.body.items);
        const out = await playlists.reorder(req.playlistOwner, String(req.params.id || ''), list);
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.json({ items: out.items.map(wireItem) });
    });

    r.delete('/:id/items/:kind/:itemId', person, async (req, res) => {
        const out = await playlists.removeItem(req.playlistOwner, String(req.params.id || ''), String(req.params.kind || ''), req.params.itemId);
        if (!out.ok) return problem(req, res, refused(out.code), out.code, out.detail);
        return res.status(204).end();
    });

    return r;
}

module.exports = { createVideoApiRoutes };
