'use strict';

/**
 * openvibe.pics — OpenVibe.Pics, served by this process for Host: openvibe.pics (server/app.js). Every page works
 * without JavaScript; public/js/pics.js adds drag-and-drop, paste and several files at once on top of the same API.
 *
 *   /                      upload (signed in; signed out too when MEDIAHUB_PICS_ANONYMOUS=1) and your latest pictures
 *   /i/<slug>              a picture: the links to share and embed, edit, add to an album, delete, report
 *   /i/<slug>.<ext>        the picture itself (what the links embed), read from Media and served from here
 *   /i/<slug>/thumb.webp   its 640-pixel thumbnail
 *   /mine, /albums         your pictures and albums;  /a/<slug> an album
 *   /staff                 the report queue (Network admin and global_mod): restore, hide, take down
 *   /api/v1/…              the API (server/pics/api.js)
 *   /robots.txt /llms.txt /terms /privacy /dmca /updates
 *
 * Pictures are unlisted: a page or a file is reachable by its link and never listed or indexed. A hidden picture is
 * 404 for everyone but its uploader and staff; a removed one is 410. The picture files are served with
 * `nosniff`, a sandboxing CSP and a 10-minute public cache, so a hidden picture leaves caches within minutes.
 */
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cache = require('openvibe-shared/cache-policy');
const seo = require('openvibe-shared/seo');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');
const { boundaryOf, readFormData } = require('../http/form-upload');
const { formatBytes } = require('../drive/rules');
const { html, raw, notice, time } = require('../render/html');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../auth/sso');
const { send, assetVersion, SITE_NAME } = require('./layout');
const store = require('./store');
const { createPicsApi } = require('./api');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const FILE_CACHE = 'public, max-age=600, s-maxage=600';
const KIND = { jpg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', avif: 'AVIF' };

function createPicsRoutes(ctx) {
    const { config, s, media, log } = ctx;
    const pics = ctx.pics;
    const cfg = config.pics;
    const base = cfg.url;
    const host = (() => { try { return new URL(base).hostname; } catch { return 'openvibe.pics'; } })();
    const r = asyncRouter();

    const hasSessionCookie = (req) => Boolean(req.cookies && (req.cookies[ACCESS_COOKIE] || req.cookies[REFRESH_COOKIE]));
    const page = (req, res, o, status = 200) => send(res, status, {
        ...o, viewer: req.viewer, private: o.private !== false && hasSessionCookie(req), baseUrl: base, path: req.originalUrl,
    });
    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    /** Who is asking, as the service wants it: { requester, staff } for a person, { ip } signed out. */
    const whoOf = (req) => (signedIn(req) ? { requester: `user:${req.viewer.subject}`, staff: pics.isStaff(req.viewer), ip: req.ip } : { ip: req.ip });
    const signInLink = (next, text = 'Sign in with OpenVibe') => html`<a class="ovp-btn ovp-btn--primary" href="/auth/login?next=${encodeURIComponent(next)}">${text}</a>`;
    const notFound = (req, res, status = 404) => page(req, res, {
        title: status === 410 ? 'Taken down' : 'Not found', cache: cache.htmlHeaders({ private: true }),
        body: status === 410
            ? html`<h1>This picture was taken down</h1><p class="muted">It broke the <a href="/terms">rules</a> or the law and is no longer on OpenVibe.Pics.</p>`
            : html`<h1>Not found</h1><p class="muted">No picture or page here. <a href="/">Upload one</a>.</p>`,
    }, status);
    const mustSignIn = (why) => (req, res, next) => (signedIn(req) ? next() : page(req, res, {
        title: 'Sign in', body: html`<h1>Sign in first</h1><p>${why}</p><p>${signInLink(req.originalUrl)}</p>`,
    }, 401));
    function sameSite(req, res, back) {
        if (sameOrigin(req, base)) return true;
        page(req, res, { title: 'Not from this site', body: html`<h1>That came from somewhere else</h1><p class="muted">A form that changes something has to come from ${host} itself. <a href="${back}">Go back</a> and send it again.</p>` }, 403);
        return false;
    }
    /** The per-caller budget the API uses, with a page of its own for a refusal (as http/pages.js budgeted()). */
    const budgeted = (name) => {
        const limit = ctx.limits.budget(name);
        return (req, res, next) => {
            let settled = false;
            limit(req, {
                statusCode: 0, setHeader: () => {}, getHeader: () => undefined, removeHeader: () => {},
                end: () => {
                    if (settled) return;
                    settled = true;
                    page(req, res, { title: 'Too many requests', body: html`<h1>Too many requests just now</h1><p class="muted">Wait a minute and send it again.</p>` }, 429);
                },
            }, (err) => { if (settled) return undefined; settled = true; return err ? next(err) : next(); });
            return undefined;
        };
    };

    // ── The shell's /shared copy and this site's stylesheet and script (public/) ──
    r.use('/shared', ovServe.handler());
    r.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── The API on this host ────────────────────────────────
    r.use('/api/v1', createPicsApi(ctx));
    r.use('/api', (req, res) => res.status(404).type('application/problem+json').send(JSON.stringify({ type: 'about:blank', title: 'Not found', status: 404, code: 'route.not_found' })));

    // ── The files ───────────────────────────────────────────
    async function serveObject(req, res, row, objectId, type) {
        const got = await media.bytes(objectId);
        if (!got.ok) return res.status(got.status === 404 || got.status === 410 ? 404 : 502).set('Cache-Control', 'no-store').type('text/plain').send(got.status === 404 || got.status === 410 ? 'Not found' : 'OpenVibe.Media did not answer.');
        const up = got.res;
        res.status(200).set({
            'Content-Type': type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'X-Robots-Tag': 'noindex',
            // Hidden pictures leave shared caches within ten minutes; their uploader and staff get no-store copies.
            'Cache-Control': row.state === 'active' ? FILE_CACHE : 'private, no-store',
            'Content-Disposition': `inline; filename="${row.slug}.${row.ext}"`,
            ETag: `"${row.sha256.slice(0, 32)}"`,
        });
        const len = up.headers.get('content-length');
        if (len) res.set('Content-Length', len);
        if (req.method === 'HEAD' || !up.body) return res.end();
        const { Readable } = require('stream');
        Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
        if (row.state === 'active') pics.viewed(row).catch(() => {});
        return undefined;
    }

    async function picture(req, res) {
        const slug = String(req.params.slug || '');
        if (!pics.isSlug(slug)) return { row: null, status: 404 };
        const row = await store.imageBySlug(s, slug);
        if (!row) return { row: null, status: 404 };
        if (row.state === 'removed') return { row, status: 410 };
        if (!pics.canSee(row, whoOf(req))) return { row: null, status: 404 };
        return { row, status: 200 };
    }

    r.get(/^\/i\/([2-9a-km-zA-HJ-NP-Z]{8})\.(jpg|png|gif|webp|avif)$/, async (req, res) => {
        req.params.slug = req.params[0];
        const { row, status } = await picture(req, res);
        if (!row || status !== 200 || row.ext !== req.params[1]) return res.status(status === 410 ? 410 : 404).set('Cache-Control', 'public, max-age=60').type('text/plain').send(status === 410 ? 'Taken down' : 'Not found');
        if (req.get('if-none-match') === `"${row.sha256.slice(0, 32)}"` && row.state === 'active') return res.status(304).set('Cache-Control', FILE_CACHE).end();
        return serveObject(req, res, row, row.object_id, row.mime_type);
    });

    r.get('/i/:slug/thumb.webp', async (req, res) => {
        const { row, status } = await picture(req, res);
        if (!row || status !== 200) return res.status(status === 410 ? 410 : 404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not found');
        return row.thumb_object_id ? serveObject(req, res, row, row.thumb_object_id, 'image/webp') : res.redirect(302, `/i/${row.slug}.${row.ext}`);
    });

    // ── Pages: forms are urlencoded, uploads multipart ──────
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));

    const thumb = (row) => html`<a class="ovp-tile${row.state !== 'active' ? ' is-hidden' : ''}" href="/i/${row.slug}"><img src="/i/${row.slug}/thumb.webp" alt="${row.title || 'Picture'}" loading="lazy" decoding="async" width="${Math.min(Number(row.width), 640)}" height="${Math.round(Math.min(Number(row.width), 640) * Number(row.height) / Math.max(1, Number(row.width)))}">${row.state !== 'active' ? html`<span class="ovp-flag">hidden</span>` : ''}</a>`;
    const grid = (rows, empty) => (rows.length ? html`<div class="ovp-grid">${rows.map(thumb)}</div>` : html`<p class="muted">${empty}</p>`);

    function uploadForm(req, { compact = false } = {}) {
        const max = signedIn(req) ? cfg.maxImageBytes : cfg.anonymousMaxImageBytes;
        return html`<form class="ovp-drop${compact ? ' ovp-drop--compact' : ''}" method="post" action="/upload" enctype="multipart/form-data" data-pics-upload data-max="${max}">
<div class="ovp-drop-inner">
<span class="ovp-drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-4.86 8.86-3 3.87L9 13.14 6 17h12l-3.86-5.14Z"/></svg></span>
<p class="ovp-drop-title">Drop pictures here, paste one, or choose files</p>
<p class="ovp-drop-hint">JPEG, PNG, GIF, WebP or AVIF, up to ${formatBytes(max)} each. Location and camera details are removed.</p>
<label class="ovp-btn ovp-btn--primary ovp-file"><input type="file" name="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" required data-pics-input> Choose a picture</label>
<div class="ovp-drop-fields"><label for="up-title">Title (optional)</label><input id="up-title" name="title" type="text" maxlength="120" placeholder="What is it?"></div>
<button class="ovp-btn ovp-btn--primary ovp-nojs-submit" type="submit">Upload</button>
</div>
<ol class="ovp-results" data-pics-results aria-live="polite"></ol>
</form>`;
    }

    // ── Home ────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const mine = signedIn(req) ? (await store.imagesOf(s, whoOf(req).requester, { limit: 12 })).rows : [];
        const canUpload = signedIn(req) || cfg.anonymous;
        return page(req, res, {
            index: true,
            description: 'Upload a picture and get a link to share or embed anywhere. Albums, no ads, open source, with location and camera details removed from every picture.',
            scripts: canUpload ? ['js/pics.js'] : [],
            body: html`<header class="ovp-hero"><p class="ovp-eyebrow">${SITE_NAME}</p>
<h1>Share pictures. <span class="ovp-accent">Fast, open, yours.</span></h1>
<p class="ovp-lede">Drop a picture, get a link to share or embed anywhere: on a forum, in a chat, on your site. No ads, no feed, and nothing about you hidden in the file.</p></header>
${canUpload ? uploadForm(req) : html`<section class="ovp-drop ovp-drop--signin"><div class="ovp-drop-inner"><p class="ovp-drop-title">Sign in to upload</p><p class="ovp-drop-hint">Your OpenVibe account keeps your pictures and albums together, so you can delete them whenever you like.</p><p>${signInLink('/')}</p></div></section>`}
${signedIn(req) ? html`<section class="ovp-section" aria-labelledby="h-latest"><div class="ovp-section-head"><h2 id="h-latest">Your latest pictures</h2><a href="/mine">All of them</a></div>${grid(mine, 'Nothing yet: your uploads show up here.')}</section>` : ''}
<section class="ovp-section ovp-features" aria-label="What you get">
<div class="ovp-feature"><h3>Links that work everywhere</h3><p>A page to share, a direct link for <code>&lt;img&gt;</code>, and Markdown, BBCode and HTML ready to copy.</p></div>
<div class="ovp-feature"><h3>Unlisted by default</h3><p>Only people with the link see a picture. Nothing is listed, ranked or indexed.</p></div>
<div class="ovp-feature"><h3>Clean files</h3><p>Every picture is re-encoded, and its GPS position, camera serial and other hidden details are removed before anyone sees it.</p></div>
<div class="ovp-feature"><h3>Albums</h3><p>Put pictures together and share the album with one link.</p></div>
</section>`,
        });
    });

    // ── Upload (the no-JavaScript form; the script uses the API) ──
    const spoolDir = () => config.tmpDir || path.join(os.tmpdir(), 'mediahub-uploads');
    const uploadFailed = (req, res, detail, status = 422) => page(req, res, {
        title: 'Upload failed', scripts: ['js/pics.js'],
        body: html`<h1>That upload did not work</h1>${notice(detail, 'warn')}${uploadForm(req, { compact: true })}`,
    }, status);

    r.post('/upload', budgeted('pics.image.upload'), async (req, res) => {
        if (!signedIn(req) && !cfg.anonymous) return page(req, res, { title: 'Sign in', body: html`<h1>Sign in to upload</h1><p>${signInLink('/')}</p>` }, 401);
        if (!sameSite(req, res, '/')) return undefined;
        const type = String(req.get('content-type') || '');
        const boundary = /^multipart\/form-data/i.test(type) ? boundaryOf(type) : null;
        if (!boundary) return uploadFailed(req, res, 'That was not a picture upload. Choose a picture and send the form again.');
        const max = (signedIn(req) ? cfg.maxImageBytes : cfg.anonymousMaxImageBytes) + 64 * 1024;
        fs.mkdirSync(spoolDir(), { recursive: true });
        const tmp = path.join(spoolDir(), `pic-${crypto.randomBytes(8).toString('hex')}`);
        const got = await readFormData(req, { boundary, filePath: tmp, maxBytes: max });
        try {
            if (got.error === 'too_large') return uploadFailed(req, res, `A picture can be up to ${formatBytes(max - 64 * 1024)}.`, 413);
            if (got.error || !got.file || !got.file.size) return uploadFailed(req, res, 'No picture arrived. Choose one and send the form again.');
            const out = await pics.upload(whoOf(req), { buffer: fs.readFileSync(got.file.path), name: got.file.filename }, { title: got.fields.title || '' });
            if (!out.ok) return uploadFailed(req, res, out.detail, out.status);
            if (out.deleteKey) return picturePage(req, res, out.image, { deleteKey: out.deleteKey, fresh: true });
            return res.redirect(303, `/i/${out.image.slug}?new=1`);
        } finally {
            fs.rm(tmp, { force: true }, () => {});
        }
    });

    // ── A picture ───────────────────────────────────────────
    function copyRow(label, value, id) {
        return html`<div class="ovp-copy"><label for="${id}">${label}</label><div class="ovp-copy-row"><input id="${id}" type="text" readonly value="${value}" spellcheck="false"><button class="ovp-btn" type="button" data-copy="${id}">Copy</button></div></div>`;
    }

    async function picturePage(req, res, row, { deleteKey = null, fresh = false, message = null } = {}) {
        const who = whoOf(req);
        const owner = pics.isOwner(row, who);
        const L = pics.links(row);
        const albums = owner ? await store.albumsOf(s, who.requester) : [];
        const holding = owner ? await store.albumsHolding(s, row.id) : [];
        const title = row.title || 'Untitled picture';
        const hidden = row.state !== 'active';
        return page(req, res, {
            title, noindex: true,
            description: row.description || `${title}: a picture on ${SITE_NAME}.`,
            image: hidden ? undefined : L.direct, ogType: 'article',
            scripts: ['js/pics.js'],
            private: deleteKey ? true : undefined,
            body: html`${message ? notice(message, 'ok') : ''}${fresh || req.query.new ? notice('Uploaded. Copy a link below to share it.', 'ok') : ''}
${deleteKey ? html`<div class="notice warn" role="status"><b>Keep this delete link.</b> It is the only way to delete this picture, and it is shown only now:<br><code class="ovp-key">${base}/i/${row.slug}/delete?key=${deleteKey}</code></div>` : ''}
${hidden ? notice(row.state === 'hidden' ? 'This picture is hidden while staff look at reports about it. Only you and staff can see it.' : 'This picture was taken down.', 'warn') : ''}
<article class="ovp-picture">
<h1 class="ovp-title">${title}</h1>
<figure class="ovp-figure"><a href="/i/${row.slug}.${row.ext}"><img src="/i/${row.slug}.${row.ext}" alt="${title}" width="${row.width}" height="${row.height}" decoding="async"></a></figure>
<p class="ovp-meta">${Number(row.width)} × ${Number(row.height)} · ${KIND[row.ext] || row.ext}${row.animated ? ' (animated)' : ''} · ${formatBytes(row.bytes)} · uploaded ${time(row.created_at)}</p>
${row.description ? html`<p class="ovp-desc">${row.description}</p>` : ''}
</article>
<section class="ovp-share" aria-labelledby="h-share"><h2 id="h-share">Share and embed</h2>
${copyRow('Link to this page', L.page, 'c-page')}${copyRow('Direct link (for <img> and forums)', L.direct, 'c-direct')}${copyRow('Markdown', L.markdown, 'c-md')}${copyRow('BBCode (forums)', L.bbcode, 'c-bb')}${copyRow('HTML', L.html, 'c-html')}
</section>
${owner ? html`<section class="ovp-section ovp-owner" aria-labelledby="h-yours"><h2 id="h-yours">Yours</h2>
<form class="ovp-form" method="post" action="/i/${row.slug}/edit">
<label for="e-title">Title</label><input id="e-title" name="title" type="text" maxlength="120" value="${row.title}">
<label for="e-desc">Description</label><textarea id="e-desc" name="description" rows="3" maxlength="2000">${row.description}</textarea>
<p><button class="ovp-btn ovp-btn--primary" type="submit">Save</button></p></form>
<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/album">
<label for="e-album">Add to an album</label>
<select id="e-album" name="album">${albums.map((a) => html`<option value="${a.slug}">${a.title}</option>`)}<option value="">A new album…</option></select>
<input name="new_title" type="text" maxlength="120" placeholder="New album name" aria-label="New album name">
<button class="ovp-btn" type="submit">Add</button></form>
${holding.length ? html`<p class="muted">In ${holding.map((a, i) => html`${i ? ', ' : ''}<a href="/a/${a.slug}">${a.title}</a>`)}.</p>` : ''}
<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/delete" data-confirm="Delete this picture for good?"><button class="ovp-btn ovp-btn--danger" type="submit">Delete this picture</button> <span class="muted">Its links stop working at once.</span></form>
</section>` : ''}
${!owner && !hidden ? html`<details class="ovp-report"><summary>Report this picture</summary>
<form class="ovp-form" method="post" action="/i/${row.slug}/report">
<fieldset><legend>What is wrong with it?</legend>
${pics.REASONS.map((r) => html`<label class="ovp-radio"><input type="radio" name="reason" value="${r}" required> ${pics.REASON_TEXT[r]}</label>`)}
</fieldset>
<label for="r-note">Anything staff should know (optional)</label><textarea id="r-note" name="note" rows="2" maxlength="500"></textarea>
<p><button class="ovp-btn" type="submit">Send the report</button> <span class="muted">Copyright owners can also send a notice through <a href="/dmca">the DMCA page</a>.</span></p>
</form></details>` : ''}`,
        });
    }

    r.get('/i/:slug', async (req, res) => {
        const { row, status } = await picture(req, res);
        if (!row || status !== 200) return notFound(req, res, status);
        return picturePage(req, res, row);
    });

    const ownPicture = async (req, res) => {
        const { row } = await picture(req, res);
        if (!row || !pics.isOwner(row, whoOf(req))) { notFound(req, res); return null; }
        return row;
    };

    r.post('/i/:slug/edit', mustSignIn('Sign in to change your picture.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const row = await ownPicture(req, res);
        if (!row) return undefined;
        await pics.edit(row, { title: req.body.title, description: req.body.description });
        return res.redirect(303, `/i/${row.slug}`);
    });

    r.post('/i/:slug/album', mustSignIn('Sign in to use albums.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const row = await ownPicture(req, res);
        if (!row) return undefined;
        const owner = whoOf(req).requester;
        let album = req.body.album ? await store.albumBySlug(s, String(req.body.album)) : null;
        if (album && album.owner !== owner) album = null;
        if (!album) {
            const made = await pics.createAlbum(owner, { title: req.body.new_title });
            if (!made.ok) return picturePage(req, res, row, { message: made.detail });
            album = made.album;
        }
        const added = await pics.addToAlbum(album, row);
        if (!added.ok) return picturePage(req, res, row, { message: added.detail });
        return res.redirect(303, `/a/${album.slug}`);
    });

    r.post('/i/:slug/delete', budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const { row } = await picture(req, res);
        const byKey = row && pics.deleteKeyMatches(row, String(req.body.key || ''));
        if (!row || !(pics.isOwner(row, whoOf(req)) || byKey)) return notFound(req, res);
        await pics.remove(row);
        return page(req, res, { title: 'Deleted', body: html`<h1>Deleted</h1><p>The picture and its links are gone.</p><p><a class="ovp-btn ovp-btn--primary" href="/">Upload another</a>${signedIn(req) ? html` <a class="ovp-btn" href="/mine">Your pictures</a>` : ''}</p>` });
    });

    // The delete link a signed-out uploader keeps: a page with one button (a GET never deletes).
    r.get('/i/:slug/delete', async (req, res) => {
        const { row } = await picture(req, res);
        const key = String(req.query.key || '');
        if (!row || !pics.deleteKeyMatches(row, key)) return notFound(req, res);
        return page(req, res, {
            title: 'Delete this picture', noindex: true, private: true,
            body: html`<h1>Delete this picture?</h1><p><img class="ovp-confirm-thumb" src="/i/${row.slug}/thumb.webp" alt=""></p>
<form method="post" action="/i/${row.slug}/delete"><input type="hidden" name="key" value="${key}"><button class="ovp-btn ovp-btn--danger" type="submit">Delete it for good</button> <a href="/i/${row.slug}">Keep it</a></form>`,
        });
    });

    r.post('/i/:slug/report', budgeted('pics.report.create'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const { row } = await picture(req, res);
        if (!row || row.state !== 'active') return notFound(req, res);
        const who = whoOf(req);
        const out = await pics.report(row, { reporter: who.requester || pics.addressId(who.ip), reason: String(req.body.reason || ''), note: req.body.note });
        if (!out.ok) return picturePage(req, res, row, { message: out.detail });
        return page(req, res, {
            title: 'Report sent', private: true,
            body: html`<h1>Thank you</h1><p>${out.added ? 'Your report was sent to OpenVibe staff.' : 'You had already reported this picture; staff have your report.'}${out.hidden ? ' The picture is hidden until staff look at it.' : ''}</p><p><a href="/">Back to ${SITE_NAME}</a></p>`,
        });
    });

    // ── Your pictures and albums ────────────────────────────
    r.get('/mine', mustSignIn('Your pictures belong to your OpenVibe account.'), async (req, res) => {
        const before = /^pic_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
        const owner = whoOf(req).requester;
        const out = await store.imagesOf(s, owner, { limit: 48, before });
        const use = await store.usageOf(s, owner);
        return page(req, res, {
            title: 'Your pictures', scripts: ['js/pics.js'],
            body: html`<div class="ovp-section-head"><h1>Your pictures</h1><span class="muted">${use.images} picture${use.images === 1 ? '' : 's'} · ${formatBytes(use.bytes)} of ${formatBytes(cfg.quotaBytes)}</span></div>
${uploadForm(req, { compact: true })}
${grid(out.rows, 'Nothing yet. Upload a picture above.')}
${out.next ? html`<p><a class="ovp-btn" href="/mine?before=${out.next}">Older pictures</a></p>` : ''}`,
        });
    });

    r.get('/albums', mustSignIn('Albums belong to your OpenVibe account.'), async (req, res) => {
        const albums = await store.albumsOf(s, whoOf(req).requester);
        return page(req, res, {
            title: 'Your albums',
            body: html`<h1>Your albums</h1>
<form class="ovp-form ovp-inline" method="post" action="/albums"><label for="a-title">New album</label><input id="a-title" name="title" type="text" maxlength="120" required placeholder="Trip to the coast"><button class="ovp-btn ovp-btn--primary" type="submit">Create</button></form>
${albums.length ? html`<div class="ovp-albums">${albums.map((a) => html`<a class="ovp-album" href="/a/${a.slug}">${a.cover_slug ? html`<img src="/i/${a.cover_slug}/thumb.webp" alt="" loading="lazy">` : html`<span class="ovp-album-empty" aria-hidden="true"></span>`}<span class="ovp-album-title">${a.title}</span><span class="muted">${a.image_count} picture${Number(a.image_count) === 1 ? '' : 's'}</span></a>`)}</div>`
        : html`<p class="muted">No albums yet. Create one here, or add a picture to a new album from its page.</p>`}`,
        });
    });

    r.post('/albums', mustSignIn('Sign in to use albums.'), budgeted('pics.album.create'), async (req, res) => {
        if (!sameSite(req, res, '/albums')) return undefined;
        const made = await pics.createAlbum(whoOf(req).requester, { title: req.body.title });
        if (!made.ok) return page(req, res, { title: 'Album', body: html`<h1>Your albums</h1>${notice(made.detail, 'warn')}<p><a href="/albums">Back</a></p>` }, made.status);
        return res.redirect(303, `/a/${made.album.slug}`);
    });

    async function ownAlbum(req, res) {
        const slug = String(req.params.slug || '');
        const album = pics.isSlug(slug) ? await store.albumBySlug(s, slug) : null;
        if (!album || album.owner !== whoOf(req).requester) { notFound(req, res); return null; }
        return album;
    }

    r.get('/a/:slug', async (req, res) => {
        const slug = String(req.params.slug || '');
        const album = pics.isSlug(slug) ? await store.albumBySlug(s, slug) : null;
        if (!album) return notFound(req, res);
        const owner = album.owner === whoOf(req).requester;
        const rows = await store.albumImages(s, album.id, { visibleOnly: !owner });
        return page(req, res, {
            title: album.title, noindex: true, scripts: ['js/pics.js'],
            image: rows[0] ? `${base}/i/${rows[0].slug}.${rows[0].ext}` : undefined,
            body: html`<div class="ovp-section-head"><h1>${album.title}</h1><span class="muted">${rows.length} picture${rows.length === 1 ? '' : 's'}</span></div>
${album.description ? html`<p class="ovp-desc">${album.description}</p>` : ''}
${copyRow('Link to this album', `${base}/a/${album.slug}`, 'c-album')}
${grid(rows, owner ? 'Empty. Add pictures from their pages.' : 'Nothing to show here.')}
${owner ? html`<section class="ovp-section ovp-owner" aria-labelledby="h-manage"><h2 id="h-manage">Manage</h2>
<form class="ovp-form" method="post" action="/a/${album.slug}/edit"><label for="al-title">Name</label><input id="al-title" name="title" type="text" maxlength="120" value="${album.title}" required>
<label for="al-desc">Description</label><textarea id="al-desc" name="description" rows="2" maxlength="2000">${album.description}</textarea><p><button class="ovp-btn ovp-btn--primary" type="submit">Save</button></p></form>
${rows.length ? html`<form class="ovp-form ovp-inline" method="post" action="/a/${album.slug}/remove"><label for="al-rm">Take out of the album</label><select id="al-rm" name="image">${rows.map((x) => html`<option value="${x.slug}">${x.title || x.slug}</option>`)}</select><button class="ovp-btn" type="submit">Take out</button></form>` : ''}
<form class="ovp-form ovp-inline" method="post" action="/a/${album.slug}/delete" data-confirm="Delete this album? The pictures stay."><button class="ovp-btn ovp-btn--danger" type="submit">Delete the album</button> <span class="muted">The pictures in it stay.</span></form>
</section>` : ''}`,
        });
    });

    r.post('/a/:slug/edit', mustSignIn('Sign in to use albums.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/a/${req.params.slug}`)) return undefined;
        const album = await ownAlbum(req, res);
        if (!album) return undefined;
        const title = String(req.body.title || '').replace(/\s+/g, ' ').trim().slice(0, pics.LIMITS.albumTitle);
        await store.updateAlbum(s, album.id, { title: title || null, description: req.body.description == null ? null : String(req.body.description).trim().slice(0, pics.LIMITS.description) });
        return res.redirect(303, `/a/${album.slug}`);
    });

    r.post('/a/:slug/remove', mustSignIn('Sign in to use albums.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/a/${req.params.slug}`)) return undefined;
        const album = await ownAlbum(req, res);
        if (!album) return undefined;
        const image = pics.isSlug(req.body.image) ? await store.imageBySlug(s, String(req.body.image)) : null;
        if (image) await store.removeFromAlbum(s, album.id, image.id);
        return res.redirect(303, `/a/${album.slug}`);
    });

    r.post('/a/:slug/delete', mustSignIn('Sign in to use albums.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/a/${req.params.slug}`)) return undefined;
        const album = await ownAlbum(req, res);
        if (!album) return undefined;
        await store.deleteAlbum(s, album.id);
        return res.redirect(303, '/albums');
    });

    // ── Staff ───────────────────────────────────────────────
    const staffOnly = (req, res, next) => (signedIn(req) && pics.isStaff(req.viewer) ? next() : notFound(req, res));
    r.get('/staff', staffOnly, async (req, res) => {
        const state = ['hidden', 'reported', 'removed'].includes(String(req.query.state)) ? String(req.query.state) : 'hidden';
        const rows = await store.staffQueue(s, { state });
        const counts = await store.staffCounts(s);
        const items = [];
        for (const row of rows) items.push({ row, reports: await store.reportsFor(s, row.id) });
        const tab = (k, label) => (k === state ? html`<span class="ovp-tab on" aria-current="page">${label} (${counts[k]})</span>` : html`<a class="ovp-tab" href="/staff?state=${k}">${label} (${counts[k]})</a>`);
        return page(req, res, {
            title: 'Pics reports', private: true,
            body: html`<h1>Reports</h1><nav class="ovp-tabs">${tab('hidden', 'Hidden, waiting')}${tab('reported', 'Reported, still up')}${tab('removed', 'Taken down')}</nav>
${items.length ? items.map(({ row, reports }) => html`<article class="ovp-staff">
${row.state !== 'removed' ? html`<a href="/i/${row.slug}"><img src="/i/${row.slug}/thumb.webp" alt="" loading="lazy"></a>` : html`<span class="ovp-album-empty" aria-hidden="true"></span>`}
<div><p><b>${row.title || row.slug}</b> · ${row.state} · ${row.report_count} report${Number(row.report_count) === 1 ? '' : 's'} · ${row.owner ? 'by an account' : 'signed out'} · ${time(row.created_at)}</p>
<ul>${reports.map((x) => html`<li><b>${pics.REASON_TEXT[x.reason] || x.reason}</b>${x.note ? html`: ${x.note}` : ''} <span class="muted">${time(x.created_at)}</span></li>`)}</ul>
${row.state !== 'removed' ? html`<form class="ovp-inline" method="post" action="/staff/i/${row.slug}">
${row.state === 'hidden' ? html`<button class="ovp-btn" name="action" value="restore">Looks fine: show it</button>` : html`<button class="ovp-btn" name="action" value="hide">Hide</button>`}
<input name="reason" type="text" maxlength="60" placeholder="Why (kept with the blocklist)" aria-label="Why it is taken down">
<button class="ovp-btn ovp-btn--danger" name="action" value="takedown">Take down and block</button></form>` : ''}</div></article>`) : html`<p class="muted">Nothing here.</p>`}
<p class="small muted">Taking a picture down deletes its bytes and puts its hashes on the blocklist: the same picture, or a resized or re-compressed copy, cannot be uploaded again. Child sexual abuse material must also be reported to NCMEC's CyberTipline.</p>`,
        });
    });

    r.post('/staff/i/:slug', staffOnly, async (req, res) => {
        if (!sameSite(req, res, '/staff')) return undefined;
        const slug = String(req.params.slug || '');
        const row = pics.isSlug(slug) ? await store.imageBySlug(s, slug) : null;
        if (!row) return notFound(req, res);
        await pics.moderate(row, String(req.body.action || ''), { by: whoOf(req).requester, reason: req.body.reason });
        return res.redirect(303, `/staff?state=${row.state === 'active' ? 'reported' : 'hidden'}`);
    });

    // ── Discovery, legal, update log ────────────────────────
    r.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`# openvibe.pics: pictures are unlisted; only the home page is for search engines.\n${seo.robotsTxt({ disallow: ['/i/', '/a/', '/mine', '/albums', '/staff', '/api/', '/auth/', '/upload'] })}`));
    r.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt({
        name: SITE_NAME,
        summary: 'Picture hosting on the OpenVibe network: upload a picture, get a link to share or embed, albums, no ads.',
        details: 'Pictures are unlisted (reachable only by their link). Each one is re-encoded with its metadata removed. API: POST /api/v1/images with the picture as the body (an OpenVibe sign-in token as a Bearer).',
        sections: [{ title: 'Start here', links: [{ title: SITE_NAME, url: `${base}/` }, { title: 'Terms', url: `${base}/terms` }, { title: 'DMCA', url: `${base}/dmca` }] }],
    })));
    r.get('/updates', (req, res) => page(req, res, {
        index: true, title: 'What shipped on OpenVibe.Pics', description: 'Every change deployed to OpenVibe.Pics, newest first.',
        body: raw(frame.updatesBody({ service: 'media-hub', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));
    const legal = require('openvibe-shared/legal');
    r.get(legal.PATHS, legal.handler({ id: 'media-hub', service: 'media-hub', host, name: SITE_NAME, profile: 'ugc' }));

    r.use((req, res) => notFound(req, res));
    // eslint-disable-next-line no-unused-vars
    r.use((err, req, res, _next) => {
        log.error('[OpenVibe.Pics]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return undefined;
        if (err && err.type === 'entity.too.large') return res.status(413).type('text/plain').send('That request was too large.');
        return page(req, res, { title: 'Something went wrong', cache: cache.htmlHeaders({ private: true }), body: html`<h1>Something went wrong on our side</h1><p class="muted">Try again in a moment.</p>` }, 500);
    });
    return r;
}

module.exports = { createPicsRoutes };
