'use strict';

/**
 * /api/v1 on openvibe.pics — OpenVibe.Pics' API. A person is a Network token as a Bearer, or this site's session (a
 * session write must come from openvibe.pics itself). App, agent and service tokens are refused: a picture is
 * somebody's own. Signed-out uploads answer only when MEDIAHUB_PICS_ANONYMOUS=1.
 *
 *   POST   /images                       person    upload: the picture is the body (Content-Type image/*);
 *                                                  X-Title and X-Filename headers (URI-encoded) are optional
 *   GET    /images/:slug                 anyone    a picture's metadata and links (hidden: uploader and staff only)
 *   PATCH  /images/:slug                 uploader  { title, description, alt }
 *   POST   /images/:slug/describe        uploader  OpenVibe.AI drafts its alt text, a caption and tags (the picture
 *                                                  goes to OpenVibe.AI; only on this call)
 *   DELETE /images/:slug                 uploader  (signed out: the X-Delete-Key header from the upload)
 *   POST   /images/:slug/reports         anyone    { reason, note }
 *   GET    /me/images?before=            person    your pictures, newest first
 *   GET    /albums                       person    your albums
 *   POST   /albums                       person    { title, description }
 *   GET    /albums/:slug                 anyone    an album and its pictures
 *   POST   /albums/:slug/images          owner     { image: slug }
 *   DELETE /albums/:slug/images/:image   owner
 *   DELETE /albums/:slug                 owner     (the pictures stay)
 *
 * Refusals are RFC 9457 problem+json with a stable code (pics.*).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');
const store = require('./store');

function createPicsApi(ctx) {
    const { config, s, principal, limits } = ctx;
    const pics = ctx.pics;
    const cfg = config.pics;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    const whoOf = (req) => (req.principal.kind === 'user'
        ? { requester: req.principal.requester, staff: pics.isStaff({ kind: 'user', role: req.principal.role || (req.principal.claims && req.principal.claims.role) }), ip: req.ip }
        : { ip: req.ip });

    /** A person may act; signed out only where `anonymousOk`; app tokens never. Session writes come from this site. */
    function gate({ anonymousOk = false } = {}) {
        return (req, res, next) => {
            const p = req.principal;
            if (p.kind !== 'user' && p.kind !== 'anonymous') return problem(req, res, 403, 'pics.person_required', 'Pictures belong to a person; an app, agent or service token cannot upload or change them.');
            if (p.kind === 'anonymous' && !anonymousOk) return problem(req, res, 401, 'token.required', 'Sign in at openvibe.pics, or send a person\'s Network token as a Bearer.');
            if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, cfg.url)) return problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.pics itself.');
            return next();
        };
    }
    const person = gate();
    const anyone = gate({ anonymousOk: true });
    const header = (req, name, max) => { try { return decodeURIComponent(String(req.get(name) || '')).slice(0, max); } catch { return ''; } };

    async function load(req, res) {
        const slug = String(req.params.slug || '');
        const row = pics.isSlug(slug) ? await store.imageBySlug(s, slug) : null;
        if (!row) { problem(req, res, 404, 'pics.not_found', 'No such picture.'); return null; }
        if (row.state === 'removed') { problem(req, res, 410, 'pics.taken_down', 'This picture was taken down.'); return null; }
        if (!pics.canSee(row, whoOf(req))) { problem(req, res, 404, 'pics.not_found', 'No such picture.'); return null; }
        return row;
    }
    async function loadOwn(req, res) {
        const row = await load(req, res);
        if (!row) return null;
        if (!pics.isOwner(row, whoOf(req))) { problem(req, res, 403, 'pics.not_yours', 'Only the person who uploaded this picture can change it.'); return null; }
        return row;
    }

    // ── Upload: the raw picture is the body ─────────────────
    const rawBody = express.raw({ type: () => true, limit: Math.max(cfg.maxImageBytes, cfg.anonymousMaxImageBytes) + 1 });
    r.post('/images', anyone, limits.budget('pics.image.upload'), (req, res, next) => rawBody(req, res, (err) => {
        if (err && err.type === 'entity.too.large') return problem(req, res, 413, 'pics.too_large', `A picture can be up to ${Math.round(cfg.maxImageBytes / 1024 / 1024)} MB.`);
        return next(err);
    }), async (req, res) => {
        if (req.principal.kind === 'anonymous' && !cfg.anonymous) return problem(req, res, 401, 'pics.sign_in_required', 'Sign in with OpenVibe to upload pictures.');
        if (!/^image\//i.test(String(req.get('content-type') || ''))) return problem(req, res, 415, 'pics.not_an_image', 'Send the picture as the body, with its image/* Content-Type.');
        const out = await pics.upload(whoOf(req), { buffer: Buffer.isBuffer(req.body) ? req.body : null, name: header(req, 'x-filename', 200) }, { title: header(req, 'x-title', 200) });
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        res.set('Location', `/api/v1/images/${out.image.slug}`);
        return res.status(201).json({ ...pics.toWire(out.image, { owner: true }), ...(out.deleteKey ? { delete_key: out.deleteKey, delete_url: `${cfg.url}/i/${out.image.slug}/delete?key=${out.deleteKey}` } : {}) });
    });

    r.use(express.json({ limit: '64kb' }));

    r.get('/images/:slug', async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        return res.json(pics.toWire(row, { owner: pics.isOwner(row, whoOf(req)) }));
    });

    r.patch('/images/:slug', person, limits.budget('pics.image.write'), async (req, res) => {
        const row = await loadOwn(req, res);
        if (!row) return undefined;
        const b = req.body || {};
        return res.json(pics.toWire(await pics.edit(row, { title: b.title, description: b.description, alt: b.alt }), { owner: true }));
    });

    r.post('/images/:slug/describe', person, limits.budget('pics.image.describe'), async (req, res) => {
        const row = await loadOwn(req, res);
        if (!row) return undefined;
        const out = await ctx.picsDescribe.describe(row);
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        return res.json(pics.toWire(out.row, { owner: true }));
    });

    r.delete('/images/:slug', anyone, limits.budget('pics.image.write'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        if (!(pics.isOwner(row, whoOf(req)) || pics.deleteKeyMatches(row, String(req.get('x-delete-key') || '')))) return problem(req, res, 403, 'pics.not_yours', 'Only the person who uploaded this picture can delete it.');
        await pics.remove(row);
        return res.status(204).end();
    });

    r.post('/images/:slug/reports', anyone, limits.budget('pics.report.create'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        const who = whoOf(req);
        const b = req.body || {};
        const out = await pics.report(row, { reporter: who.requester || pics.addressId(who.ip), reason: String(b.reason || ''), note: b.note });
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        return res.status(out.added ? 201 : 200).json({ reported: true, already: !out.added, hidden: out.hidden });
    });

    r.get('/me/images', person, async (req, res) => {
        const before = /^pic_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 48));
        const out = await store.imagesOf(s, whoOf(req).requester, { limit, before });
        return res.json({ images: out.rows.map((x) => pics.toWire(x, { owner: true })), next: out.next, usage: await store.usageOf(s, whoOf(req).requester), quota_bytes: cfg.quotaBytes });
    });

    // ── Albums ──────────────────────────────────────────────
    const albumWire = (a, images) => ({ id: a.id, slug: a.slug, title: a.title, description: a.description, url: `${cfg.url}/a/${a.slug}`, created_at: a.created_at, updated_at: a.updated_at, ...(images ? { images } : { image_count: Number(a.image_count || 0) }) });
    async function ownAlbum(req, res) {
        const slug = String(req.params.slug || '');
        const a = pics.isSlug(slug) ? await store.albumBySlug(s, slug) : null;
        if (!a || a.owner !== whoOf(req).requester) { problem(req, res, 404, 'pics.album_not_found', 'No such album of yours.'); return null; }
        return a;
    }

    r.get('/albums', person, async (req, res) => res.json({ albums: (await store.albumsOf(s, whoOf(req).requester)).map((a) => albumWire(a)) }));

    r.post('/albums', person, limits.budget('pics.album.create'), async (req, res) => {
        const out = await pics.createAlbum(whoOf(req).requester, req.body || {});
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        res.set('Location', `/api/v1/albums/${out.album.slug}`);
        return res.status(201).json(albumWire(out.album, []));
    });

    r.get('/albums/:slug', async (req, res) => {
        const slug = String(req.params.slug || '');
        const a = pics.isSlug(slug) ? await store.albumBySlug(s, slug) : null;
        if (!a) return problem(req, res, 404, 'pics.album_not_found', 'No such album.');
        const owner = a.owner === whoOf(req).requester;
        return res.json(albumWire(a, (await store.albumImages(s, a.id, { visibleOnly: !owner })).map((x) => pics.toWire(x, { owner }))));
    });

    r.post('/albums/:slug/images', person, limits.budget('pics.image.write'), async (req, res) => {
        const a = await ownAlbum(req, res);
        if (!a) return undefined;
        const imgSlug = String((req.body || {}).image || '');
        const img = pics.isSlug(imgSlug) ? await store.imageBySlug(s, imgSlug) : null;
        if (!img || !pics.isOwner(img, whoOf(req)) || img.state === 'removed') return problem(req, res, 422, 'pics.not_yours', 'image: the slug of one of your pictures');
        const out = await pics.addToAlbum(a, img);
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        return res.status(204).end();
    });

    r.delete('/albums/:slug/images/:image', person, limits.budget('pics.image.write'), async (req, res) => {
        const a = await ownAlbum(req, res);
        if (!a) return undefined;
        const img = pics.isSlug(req.params.image) ? await store.imageBySlug(s, String(req.params.image)) : null;
        if (img) await store.removeFromAlbum(s, a.id, img.id);
        return res.status(204).end();
    });

    r.delete('/albums/:slug', person, limits.budget('pics.image.write'), async (req, res) => {
        const a = await ownAlbum(req, res);
        if (!a) return undefined;
        await store.deleteAlbum(s, a.id);
        return res.status(204).end();
    });

    r.use((req, res) => problem(req, res, 404, 'route.not_found', 'No such API route on openvibe.pics.'));
    return r;
}

module.exports = { createPicsApi };
