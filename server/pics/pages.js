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
 *   /exif /content-policy /ai-training   the policy pages (server/pics/policy.js): the metadata, the content rules, AI
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
const securityTxt = require('../http/security-txt');
const seo = require('openvibe-shared/seo');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');
const { boundaryOf, readFormData } = require('../http/form-upload');
const { formatBytes } = require('../drive/rules');
const { html, raw, notice, time, shareButton } = require('../render/html');
const labelsUi = require('../render/labels-ui');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../auth/sso');
const { send, assetVersion, SITE_NAME } = require('./layout');
const store = require('./store');
const { createPicsApi } = require('./api');
const { createCommentsClient } = require('./comments-client');
const { createCommentsClient: createServiceCommentsClient } = require('../video/comments-client');
const { renderThread } = require('../comments/inline');
const { multipart: commentMultipart, readCommentForm } = require('../comments/form');
const { createPicVariants } = require('./variants');
const kit = require('openvibe-shared/kit');
const gallery = require('./gallery');
const glyphs = require('openvibe-shared/glyphs');
/** A line glyph from Shared's set, decorative (its button says what it does). */
const glyph = (name, size = 16) => raw(`<span class="ovp-glyph" aria-hidden="true">${glyphs.svg(name, { size })}</span>`);
const showcase = require('openvibe-shared/showcase');
const { PATHS: POLICY_PATHS, policyPage } = require('./policy');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const FILE_CACHE = 'public, max-age=600, s-maxage=60';
/** Only Everyone and link pictures may sit in a shared cache; anything narrower is private to each answer. */
const cacheFor = (row) => (row.state === 'active' && (row.audience === 'public' || row.audience === 'link' || row.audience === undefined) ? FILE_CACHE : 'private, no-store');
const KIND = { jpg: 'JPEG', png: 'PNG', gif: 'GIF', webp: 'WebP', avif: 'AVIF' };

function createPicsRoutes(ctx) {
    const { config, s, media, log } = ctx;
    const pics = ctx.pics;
    const comments = createCommentsClient({ fetchImpl: ctx.fetchImpl || globalThis.fetch });
    const commentModeration = createServiceCommentsClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch,
        refOf: (row) => ({ service: 'pics', type: 'picture', id: String(row.id) }) });
    const sharing = ctx.sharing;
    const cfg = config.pics;
    const base = cfg.url;
    const host = (() => { try { return new URL(base).hostname; } catch { return 'openvibe.pics'; } })();
    const r = asyncRouter();
    const describeOn = Boolean(ctx.picsDescribe && ctx.picsDescribe.enabled);
    const tagsOf = (row) => pics.tagsOf(row);
    const variants = createPicVariants({ media, maxBytes: Number(process.env.MEDIAHUB_PICS_VARIANT_CACHE_BYTES) || 64 * 1024 * 1024 });

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
            : html`<h1>Not found</h1>${raw(kit.empty({ icon: 'image', title: 'No picture here', text: 'This picture page does not exist, or was taken down.', action: { href: '/', label: 'Upload a picture', icon: 'image' } }))}`,
        styles: ['kit.css'],
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

    // ── /api/v1/<kind>/<id>/share — the uniform share API on this host ──────
    if (sharing) {
        const shareApi = express.Router();
        shareApi.use(sharing.shares.router({
            service: 'mediahub',
            authenticate: (req) => sharing.shareViewer(req.viewer),
            describe: require('../sharing').describeRef(s.db, config),
        }));
        const SHARE_PATH = /^\/api\/v1\/(?:shared-with-me$|share\/people$|[^/]+\/[^/]+\/share(?:\/|$))/;
        r.use((req, res, next) => (SHARE_PATH.test(req.path) ? shareApi(req, res, next) : next()));
    }

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
            'Cache-Control': cacheFor(row),
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
        // The share row is the authority once it exists: Only me and Specific people never serve the page or the
        // bytes. A picture from before the sharing model has no row; its page was always link-only, so it stays.
        const share = sharing ? await sharing.shareOf('picture', row.id).catch(() => null) : null;
        if (share && !await sharing.canView(req.viewer, 'picture', row.id).catch(() => false)) return { row, status: 404, denied: true };
        return { row, status: 200 };
    }

    r.get(/^\/i\/([2-9a-km-zA-HJ-NP-Z]{8})\.(jpg|png|gif|webp|avif)$/, async (req, res) => {
        req.params.slug = req.params[0];
        const { row, status } = await picture(req, res);
        if (!row || status !== 200 || row.ext !== req.params[1]) return res.status(status === 410 ? 410 : 404).set('Cache-Control', 'public, max-age=60').type('text/plain').send(status === 410 ? 'Taken down' : 'Not found');
        if (req.get('if-none-match') === `"${row.sha256.slice(0, 32)}"` && row.state === 'active') return res.status(304).set('Cache-Control', cacheFor(row)).end();
        return serveObject(req, res, row, row.object_id, row.mime_type);
    });

    // Resize and convert (server/pics/variants.js): an active picture at a ladder width, as WebP, AVIF, JPEG or PNG.
    r.get(/^\/i\/([2-9a-km-zA-HJ-NP-Z]{8})\/w\/(\d{3,4})\.(webp|avif|jpg|png)$/, budgeted('pics.image.variant'), async (req, res) => {
        req.params.slug = req.params[0];
        const { row, status } = await picture(req, res);
        if (!row || status !== 200 || row.state !== 'active') return res.status(status === 410 ? 410 : 404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not found');
        const v = await variants.get(row, Number(req.params[1]), req.params[2]);
        if (v.status !== 200) return res.status(v.status).set('Cache-Control', 'public, max-age=60').type('text/plain').send(v.status === 400 ? 'That size or format is not offered for this picture.' : 'Not available.');
        res.status(200).set({
            'Content-Type': v.type,
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            'Cross-Origin-Resource-Policy': 'cross-origin',
            'Access-Control-Allow-Origin': '*',
            'X-Robots-Tag': 'noindex',
            'Cache-Control': cacheFor(row),
            'Content-Disposition': `inline; filename="${row.slug}-${req.params[1]}.${req.params[2]}"`,
            'Content-Length': String(v.buffer.length),
        });
        return res.end(req.method === 'HEAD' ? undefined : v.buffer);
    });

    r.get('/i/:slug/thumb.webp', async (req, res) => {
        const { row, status } = await picture(req, res);
        if (!row || status !== 200) return res.status(status === 410 ? 410 : 404).set('Cache-Control', 'public, max-age=60').type('text/plain').send('Not found');
        return row.thumb_object_id ? serveObject(req, res, row, row.thumb_object_id, 'image/webp') : res.redirect(302, `/i/${row.slug}.${row.ext}`);
    });

    // ── Pages: forms are urlencoded, uploads multipart ──────
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));

    const tile = (row) => html`<a class="ovp-tile${row.state !== 'active' ? ' is-hidden' : ''}" href="/i/${row.slug}"><img src="/i/${row.slug}/thumb.webp" alt="${pics.altOf(row)}" loading="lazy" decoding="async" width="${Math.min(Number(row.width), 640)}" height="${Math.round(Math.min(Number(row.width), 640) * Number(row.height) / Math.max(1, Number(row.width)))}">${row.state !== 'active' ? html`<span class="ovp-flag">hidden</span>` : ''}</a>`;
    const thumb = (row) => {
        const labels = labelsUi.inForce(row);
        return labels.length ? html`<div class="ovp-tile-cover"${labelsUi.attrs(labels, { owner: row.owner })}>${tile(row)}</div>` : tile(row);
    };
    const grid = (rows, empty = { title: 'Nothing here yet', text: 'No picture here yet.' }) => (rows.length ? html`<div class="ovp-grid">${rows.map(thumb)}</div>` : raw(kit.empty({ icon: 'image', ...(typeof empty === 'string' ? { title: empty, text: 'No picture here yet.' } : empty) })));

    const audienceOptions = (current) => [['public', 'Everyone'], ['link', 'Anyone with the link'], ['people', 'Specific people'], ['private', 'Only me']]
        .map(([value, label]) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`);
    function uploadForm(req, { compact = false, defaultAudience = 'public' } = {}) {
        const max = signedIn(req) ? cfg.maxImageBytes : cfg.anonymousMaxImageBytes;
        return html`<form class="ovp-drop${compact ? ' ovp-drop--compact' : ''}" method="post" action="/upload" enctype="multipart/form-data" data-pics-upload data-max="${max}">
<div class="ovp-drop-inner">
<span class="ovp-drop-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="40" height="40"><path fill="currentColor" d="M19 5v14H5V5h14m0-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-4.86 8.86-3 3.87L9 13.14 6 17h12l-3.86-5.14Z"/></svg></span>
<p class="ovp-drop-title">Drop pictures here, paste one, or choose files</p>
<p class="ovp-drop-hint">JPEG, PNG, GIF, WebP or AVIF, up to ${formatBytes(max)} each. Location and camera details are removed.</p>
<label class="ovp-btn ovp-btn--primary ovp-file" data-ov-guide="pics.upload"><input type="file" name="file" accept="image/jpeg,image/png,image/gif,image/webp,image/avif" required data-pics-input> Choose a picture</label>
<div class="ovp-drop-fields"><label for="up-title">Title (optional)</label><input id="up-title" name="title" type="text" maxlength="120" placeholder="What is it?"></div>
${signedIn(req) ? html`<label>Who can open it <select name="audience">${audienceOptions(defaultAudience)}</select></label>` : ''}
<button class="ovp-btn ovp-btn--primary ovp-nojs-submit" type="submit">Upload</button>
</div>
<ol class="ovp-results" data-pics-results aria-live="polite"></ol>
</form>`;
    }

    // ── Home ────────────────────────────────────────────────
    // Pictures here are unlisted (nobody's picture is ever listed), so the home shows no gallery of other people's
    // pictures. It shows how it works, the links a picture gets, the sizes and formats, the API, the limits this
    // service enforces (from config) and questions; a signed-in person also sees their own latest pictures.
    const FORMAT_NAMES = 'JPEG, PNG, GIF, WebP or AVIF';
    const sizeText = (b) => formatBytes(b).replace(/\.0 /, ' ');
    const homeFaq = () => [
        { q: 'Is OpenVibe.Pics free?', a: `Yes. A free OpenVibe account can upload ${cfg.imagesPerDay} pictures a day, each up to ${sizeText(cfg.maxImageBytes)}, and keep up to ${sizeText(cfg.quotaBytes)}.` },
        { q: 'Who can see my pictures?', a: 'You choose who can open a picture when you upload it. Everyone is the default; you can choose anyone with the link, specific people, or only you. The public gallery is a separate opt-in on the picture page.' },
        { q: 'What is removed from my pictures?', a: 'Everything hidden in the file: the GPS position, the camera and the rest of its metadata. Your picture is decoded and saved again without any of it before anyone sees it, and the file you uploaded is not kept.' },
        { q: 'Which files can I upload?', a: `${FORMAT_NAMES}, animated GIF and WebP included. SVG and other formats are refused, so nothing is ever served as it was uploaded.` },
        { q: 'Can I get a different size or format?', a: `Yes. Every picture has links at ${variants.LADDER.join(', ')} pixels wide as WebP, AVIF, JPEG or PNG, made when first asked for.` },
        { q: 'What is not allowed?', a: 'Anything illegal, sexual content shared without consent, harassment, other people\'s private information, and spam. Every picture has a Report form, a child-safety report hides it at once, and copyright owners can use the DMCA page.' },
    ];
    r.get('/', async (req, res) => {
        const discovery = await gallery.browse(s, req.query);
        const mine = signedIn(req) ? (await store.imagesOf(s, whoOf(req).requester, { limit: 12 })).rows : [];
        const canUpload = signedIn(req) || cfg.anonymous;
        const pictureDefault = signedIn(req) ? await sharing.defaultAudience(whoOf(req).requester, 'picture') : 'link';
        const description = 'Upload a picture and get a link to share or embed anywhere: a gallery of what people chose to publish, albums, any size or format, and location and camera details removed from every picture.';
        const faq = homeFaq();
        // The curl sample keeps its line breaks: a backslash and a newline, so it can be copied and run as it is.
        const curl = ['curl -X POST ' + base + '/api/v1/images \\', '  -H "Authorization: Bearer $OPENVIBE_TOKEN" \\', '  -H "Content-Type: image/jpeg" \\', '  --data-binary @photo.jpg'].join('\n');
        const limitColumns = ['Signed in', ...(cfg.anonymous ? ['Without an account'] : [])];
        const limitRows = [
            { label: 'Largest picture', values: [sizeText(cfg.maxImageBytes), ...(cfg.anonymous ? [sizeText(cfg.anonymousMaxImageBytes)] : [])] },
            { label: 'Pictures a day', values: [String(cfg.imagesPerDay), ...(cfg.anonymous ? [String(cfg.anonymousPerDay)] : [])] },
            { label: 'Storage', values: [sizeText(cfg.quotaBytes), ...(cfg.anonymous ? ['Kept ' + cfg.anonymousIdleDays + ' days after the last view'] : [])] },
        ];
        return page(req, res, {
            index: true,
            title: `${SITE_NAME}: share and embed pictures with a link`,
            description,
            jsonLd: [
                seo.jsonLd.website({ name: SITE_NAME, url: base, description }),
                seo.jsonLd.organization(),
                seo.jsonLd.softwareApp({ name: SITE_NAME, url: base, description, category: 'MultimediaApplication', keywords: 'image hosting, picture sharing, public picture gallery, embed images, resize images, convert to WebP, alt text' }),
                seo.jsonLd.webPage({ name: SITE_NAME, url: `${base}/`, description, siteUrl: base }),
                seo.jsonLd.faq(faq),
            ],
            styles: ['kit.css', 'showcase.css'],
            scripts: ['js/pics.js', 'js/pics-gallery.js'],
            // pics.js's duplicate check hashes with window.OVUpload: Shared's file, served from /shared/, not the site's.
            sharedScripts: ['ov-upload.js'],
            body: html`${raw(showcase.hero({
                title: 'Share pictures.', accent: 'Discover something new.',
                lede: 'Drop a picture, get a link to share or embed anywhere: on a forum, in a chat, on your site. Browse what people chose to publish, or keep yours unlisted. Location and camera details are removed from every file.',
                visual: false,
            }))}
${canUpload ? uploadForm(req, { compact: true, defaultAudience: pictureDefault }) : html`<section class="ovp-drop ovp-drop--compact ovp-drop--signin"><div class="ovp-drop-inner"><p class="ovp-drop-title">Sign in to upload</p><p class="ovp-drop-hint">Your OpenVibe account keeps your pictures and albums together, so you can delete them whenever you like.</p><p>${signInLink('/')}</p></div></section>`}
${raw(gallery.render(pics, discovery))}
${signedIn(req) ? html`<section class="ovp-section" aria-labelledby="h-latest"><div class="ovp-section-head"><h2 id="h-latest">Your latest pictures</h2><a href="/mine">All of them</a></div>${grid(mine, 'Nothing yet: your uploads show up here.')}</section>` : ''}
<p class="ovp-note">The hidden data is removed by us: your picture arrives with its GPS position, its camera and the time it was taken, and we take all of it out before anyone sees the picture. <a href="/exif">How that works</a>.</p>
${raw(showcase.steps({
    title: 'How it works',
    items: [
        { title: 'Drop a picture', text: `Choose, drag or paste ${FORMAT_NAMES}, up to ${sizeText(cfg.maxImageBytes)}. Several at once works too.` },
        { title: 'Get your links', text: 'A page to share, a direct link, and Markdown, BBCode and HTML ready to copy.' },
        { title: 'Publish when you want', text: 'A picture stays out of the gallery until you publish it there. Then it is findable, countable and indexable.' },
        { title: 'Use it anywhere', text: 'Post it in a forum or a chat, embed it on your site, or put it in an album. Delete it whenever you like.' },
    ],
}))}
${raw(showcase.features({
    title: 'What you get',
    items: [
        { icon: 'link', title: 'Links that work everywhere', text: 'A page to share, a direct link for an img tag, and Markdown, BBCode and HTML ready to copy.' },
        { icon: 'shield', title: 'Your audience choice', text: 'Choose Everyone, anyone with the link, specific people, or only you. Nothing is listed, ranked or indexed without you.' },
        { icon: 'spark', title: 'Clean files', text: 'Every picture is re-encoded, and its GPS position, camera serial and other hidden details are removed before anyone sees it.' },
        { icon: 'folder', title: 'Albums', text: 'Put pictures together and share the album with one link.' },
        { icon: 'sliders', title: 'Any size, any format', text: `Every picture also comes at ${variants.LADDER[0]} to ${variants.LADDER[variants.LADDER.length - 1]} pixels wide, as WebP, AVIF, JPEG or PNG, each with a link of its own.` },
        { icon: 'text', title: 'Alt text', text: 'Say what a picture shows for people who cannot see it, or let AI draft it when you ask. It goes into every embed snippet.' },
    ],
}))}
${raw(showcase.features({
    title: 'The links a picture gets',
    lede: 'Each picture has a short name of eight letters and digits. These are the links it answers at:',
    items: [
        { icon: 'file', title: 'Its page', text: `${base}/i/<name>` },
        { icon: 'image', title: 'The picture itself, in the format you uploaded', text: `${base}/i/<name>.jpg` },
        { icon: 'sliders', title: 'Another width or format', text: `${base}/i/<name>/w/640.avif` },
        { icon: 'code', title: 'Markdown, with your alt text', text: `![alt text](${base}/i/<name>.jpg)` },
    ],
}))}
${raw(showcase.code({
    title: 'Upload from your own app',
    lede: 'The API takes the picture as the request body, with an OpenVibe sign-in token, and answers with its links.',
    samples: [{ label: 'curl', lang: 'bash', code: curl }],
}))}
${raw(showcase.limits({ title: 'What a free account gets', columns: limitColumns, rows: limitRows }))}
${raw(showcase.faq({ title: 'Questions', items: faq.map((f) => [f.q, f.a]) }))}
${raw(showcase.features({
    title: 'What we promise, in writing',
    items: [
        { icon: 'shield', title: 'What happens to your picture', href: '/exif', text: 'The metadata — the GPS position, the camera, the time it was taken — is taken out by us before anyone sees the picture, and the file you uploaded is not kept.' },
        { icon: 'book', title: 'What you may put here', href: '/content-policy', text: 'What is not allowed, how a rule is enforced, and what this site does not do: opt-in discovery, public counts, and no adverts.' },
        { icon: 'brain', title: 'Pictures and AI', href: '/ai-training', text: "We don't train AI on your content. If that ever changes, it'll be your choice, and it starts off." },
    ],
}))}
${raw(showcase.network({
    service: 'pics',
    items: [
        { to: 'cam', href: 'https://openvibe.cam', what: 'Take a photo and save it here' },
        { to: 'studio', href: 'https://openvibe.studio', what: 'Edit your pictures with AI' },
        { to: 'community', href: 'https://openvibe.community', what: 'Share pictures in pastes and discussions' },
        { to: 'meme', href: 'https://openvibe.meme', what: 'Make a meme from a picture' },
    ],
}))}
<script>${raw(showcase.NETWORK_JS)}</script>`,
        });
    });

    // ── Upload (the no-JavaScript form; the script uses the API) ──
    const spoolDir = () => config.tmpDir || path.join(os.tmpdir(), 'mediahub-uploads');
    const uploadFailed = async (req, res, detail, status = 422) => page(req, res, {
        title: 'Upload failed', scripts: ['js/pics.js'],
        body: html`<h1>That upload did not work</h1>${notice(detail, 'warn')}${uploadForm(req, { compact: true, defaultAudience: signedIn(req) ? await sharing.defaultAudience(whoOf(req).requester, 'picture') : 'link' })}`,
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
            const out = await pics.upload(whoOf(req), { buffer: fs.readFileSync(got.file.path), name: got.file.filename }, { title: got.fields.title || '', audience: got.fields.audience || undefined });
            if (!out.ok) return uploadFailed(req, res, out.detail, out.status);
            if (out.deleteKey) return picturePage(req, res, out.image, { deleteKey: out.deleteKey, fresh: true });
            if (out.duplicate) return res.redirect(303, `/i/${out.image.slug}?again=1`);
            return res.redirect(303, `/i/${out.image.slug}?new=1${out.similar ? `&like=${encodeURIComponent(out.similar.slug)}` : ''}`);
        } finally {
            fs.rm(tmp, { force: true }, () => {});
        }
    });

    // ── A picture ───────────────────────────────────────────
    function copyRow(label, value, id) {
        return html`<div class="ovp-copy"><label for="${id}">${label}</label><div class="ovp-copy-row"><input id="${id}" type="text" readonly value="${value}" spellcheck="false"><button class="ovp-btn" type="button" data-copy="${id}">Copy</button></div></div>`;
    }
    /** One link of a picture, in the copy panel: its name, what it is for, and the text to copy (the OpenVibe Kit's
     * snippet, with a copy button in its corner; without JavaScript the text is there to select and copy by hand). */
    const linkCard = (title, note, code, id) => html`<div class="ovp-link-card"><h3>${title}</h3><p class="ovp-link-note">${note}</p>${raw(kit.snippet({ code, id }))}</div>`;

    async function picturePage(req, res, row, { deleteKey = null, fresh = false, message = null, tone = 'ok' } = {}, status = 200) {
        const who = whoOf(req);
        const owner = pics.isOwner(row, who);
        const L = pics.links(row);
        if (req.method === 'GET' && gallery.isPublic(row) && !owner) await s.db.query(`INSERT INTO pics_views (image_id, visitor, day) SELECT i.id, $2, $3 FROM pics_images i WHERE i.id = $1 AND ${gallery.PUBLIC} ON CONFLICT DO NOTHING`, [row.id, pics.addressId(req.ip), s.iso().slice(0, 10)]);
        const albums = owner ? await store.albumsOf(s, who.requester) : [];
        const holding = owner ? await store.albumsHolding(s, row.id) : [];
        const title = row.title || 'Untitled picture';
        const hidden = row.state !== 'active';
        const commentsAvailable = !hidden && !!(sharing && await sharing.canView({ kind: 'anonymous' }, 'picture', row.id).catch(() => false));
        const sort = req.query.sort === 'new' ? 'new' : 'top';
        let commentsHtml = '';
        if (commentsAvailable) {
            const result = await comments.read(row.id, req.viewer && req.viewer.token, { sort, after: req.query.after });
            if (result.status === 200) {
                const answer = result.body;
                if (owner || (signedIn(req) && pics.isStaff(req.viewer))) {
                    for (const c of answer.comments) {
                        c.can_delete = true;
                        for (const reply of c.replies || []) reply.can_delete = true;
                    }
                }
                const expandedId = /^\d{1,15}$/.test(String(req.query.replies || '')) ? String(req.query.replies) : null;
                const belongs = expandedId && answer.comments.some((c) => String(c.id) === expandedId);
                const more = belongs ? await comments.replies(row.id, req.viewer && req.viewer.token, expandedId) : null;
                commentsHtml = renderThread({ answer, base: `/i/${row.slug}`, post: `/i/${row.slug}/comments?sort=${sort}`,
                    remove: `/i/${row.slug}/comments/delete?sort=${sort}`, signedIn: signedIn(req) && answer.viewer.can_comment !== false,
                    sort, replyId: req.query.reply, expandedId: belongs ? expandedId : null,
                    expandedReplies: more && more.status === 200 ? more.body.replies : null });
            } else commentsHtml = '<section class="ovc-thread" id="comments"><h2>Comments</h2><p>Comments are unavailable right now.</p></section>';
        }
        // ?like=<slug> after an upload: a near-duplicate of one of the person's own pictures (VIS-6). Only a slug of theirs is linked.
        const likeRow = owner && /^[A-Za-z0-9]{4,16}$/.test(String(req.query.like || '')) ? await store.imageBySlug(s, String(req.query.like)) : null;
        const likeSlug = likeRow && likeRow.id !== row.id && likeRow.owner === row.owner ? likeRow.slug : null;
        return page(req, res, {
            title, noindex: !gallery.isPublic(row), index: gallery.isPublic(row),
            jsonLd: gallery.isPublic(row) ? { '@context': 'https://schema.org', '@type': 'ImageObject', name: title, contentUrl: L.direct, url: L.page, caption: row.description || title, author: { '@type': 'Person', name: row.author_name || 'OpenVibe member' } } : undefined,
            description: row.description || `${title}: a picture on ${SITE_NAME}.`,
            image: hidden ? undefined : L.direct, ogType: 'article',
            scripts: ['js/pics.js', 'js/pics-gallery.js', 'js/comments.js'], styles: ['kit.css', 'thread.css'], sharedScripts: ['kit-web.js'],
            localStyles: ['css/comments.css', ...(owner ? ['css/labels.css'] : [])],
            private: deleteKey ? true : undefined,
            body: html`${message ? notice(message, tone) : ''}${fresh || req.query.new ? notice('Uploaded. Copy a link below to share it.', 'ok') : ''}${owner && req.query.turned ? notice('Turned a quarter. Every size of the picture follows.', 'ok') : ''}${owner && req.query.again ? notice('You had already uploaded this picture: here it is. Nothing was stored twice.', 'info') : ''}${owner && req.query.new && likeSlug ? notice(html`It looks like a picture you uploaded before: <a href="/i/${likeSlug}">that one</a>. If you meant to keep only one, delete the other.`, 'info') : ''}
${deleteKey ? html`<div class="notice warn" role="status"><b>Keep this delete link.</b> It is the only way to delete this picture, and it is shown only now:<br><code class="ovp-key">${base}/i/${row.slug}/delete?key=${deleteKey}</code></div>` : ''}
${hidden ? notice(row.state === 'hidden' ? 'This picture is hidden while staff look at reports about it. Only you and staff can see it.' : 'This picture was taken down.', 'warn') : ''}
<article class="ovp-picture">
<h1 class="ovp-title">${title}</h1>
${labelsUi.chips(labelsUi.inForce(row))}
<figure class="ovp-figure"${labelsUi.attrs(labelsUi.inForce(row), { owner: row.owner, opened: true })}><a href="/i/${row.slug}.${row.ext}"><img src="/i/${row.slug}.${row.ext}" alt="${pics.altOf(row)}" width="${row.width}" height="${row.height}" decoding="async"></a></figure>
<p class="ovp-meta">${Number(row.width)} × ${Number(row.height)} · ${KIND[row.ext] || row.ext}${row.animated ? ' (animated)' : ''} · ${formatBytes(row.bytes)} · uploaded ${time(row.created_at)}</p>
${await (async () => {
    const pub = gallery.isPublic(row);
    const n = pub ? await gallery.counts(s, row.id) : null;
    const who = row.author_name || 'OpenVibe member';
    const share = raw(shareButton({ url: L.page, title, text: row.description || `${title}: a picture on ${SITE_NAME}.`, image: L.direct, kind: 'picture', id: row.id }));
    return html`<div class="ovp-pic-bar">${pub ? html`<div class="ovp-pic-who"><span class="ovp-pic-av" aria-hidden="true">${who.trim().charAt(0).toUpperCase() || 'O'}</span><span class="ovp-pic-who-txt"><b>${who}</b><small>${n.views} ${n.views === 1 ? 'view' : 'views'}</small></span></div>` : ''}
<div class="ovp-pic-acts">${pub ? html`<button type="button" class="ovk-btn ovk-btn--quiet ovp-like" data-like="${row.slug}" aria-pressed="false">${glyph('heart', 18)}<span data-like-word>Like</span><span class="ovp-like-n" data-like-count>${n.likes}</span></button>` : ''}${share}</div></div>
${pub ? html`<p class="ovp-pic-status" role="status" data-like-status></p>` : ''}
${!hidden ? html`<nav class="ovp-pic-make" aria-label="Make something with this picture"><a class="ovk-btn ovk-btn--quiet" href="https://openvibe.studio/image-tools?picture=${row.slug}">${glyph('spark', 17)}<span>Edit with AI</span></a><a class="ovk-btn ovk-btn--quiet" href="https://openvibe.meme/make?picture=${row.slug}">${glyph('laugh', 17)}<span>Make a meme</span></a><a class="ovk-btn ovk-btn--quiet" href="https://openvibe.cam/">${glyph('camera', 17)}<span>Take a photo</span></a></nav>` : ''}`;
})()}
${row.description ? html`<p class="ovp-desc">${row.description}</p>` : ''}
${row.ai_caption && row.alt_source === 'ai' ? html`<p class="ovp-ai"><span class="ovp-ai-label">Described by AI</span> ${row.ai_caption}</p>` : ''}
</article>
${raw(commentsHtml)}
<section class="ovp-share" aria-labelledby="h-share"><h2 id="h-share">Share and embed</h2>
<p class="ovp-share-lede">These links follow the audience you choose in Share. Private pictures are visible only to you. The direct link is the picture itself, at full size — no page around it.</p>
<div class="ovp-link-grid">
${linkCard('Direct link', 'The picture itself, full size.', L.direct, `snip-direct-${row.slug}`)}
${linkCard('Markdown', 'For a chat or a post.', L.markdown, `snip-md-${row.slug}`)}
${linkCard('BBCode', 'For a forum.', L.bbcode, `snip-bb-${row.slug}`)}
${linkCard('HTML', 'For a page of your own.', L.html, `snip-html-${row.slug}`)}
</div>
<p class="muted">The <a href="${L.page}">page of this picture</a> shows it with its details, and carries the report form.</p>
</section>
${!hidden && variants.widthsFor(row).length ? html`<section class="ovp-section ovp-sizes" aria-labelledby="h-sizes"><h2 id="h-sizes">Resize and convert</h2>
<p class="muted">The same picture at another width or in another format, each a link of its own${row.animated ? ' (WebP keeps the animation; the others take its first frame)' : ''}.</p>
<table class="ovp-size-table"><thead><tr><th scope="col">Format</th>${variants.widthsFor(row).map((w) => html`<th scope="col">${w} px</th>`)}</tr></thead><tbody>
${[['webp', 'WebP'], ['avif', 'AVIF'], ['jpg', 'JPEG'], ['png', 'PNG']].map(([fmt, label]) => html`<tr><th scope="row">${label}</th>${variants.widthsFor(row).map((w) => html`<td><a href="/i/${row.slug}/w/${w}.${fmt}" rel="nofollow">${w}</a></td>`)}</tr>`)}
</tbody></table></section>` : ''}
${owner ? html`<section class="ovp-section ovp-owner" aria-labelledby="h-yours"><h2 id="h-yours">Yours</h2>
<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/rotate"><span>Which way is up?</span> <button class="ovk-btn ovk-btn--quiet" name="direction" value="left" type="submit">Turn left</button> <button class="ovk-btn ovk-btn--quiet" name="direction" value="right" type="submit">Turn right</button> <span class="muted">A quarter turn at a time; every size follows, and the original is kept.</span></form>
<form class="ovp-form" method="post" action="/i/${row.slug}/publication"><label for="p-tags">Tags (comma separated)</label><input id="p-tags" name="tags" maxlength="330" value="${gallery.tags(row).join(', ')}"><p>Publishing makes this picture visible to everyone, lists it in the gallery, enables public counts, and lets search engines index it.</p><button class="ovp-btn" name="listed" value="${!row.listed}">${row.listed ? 'Remove from gallery' : 'Publish to gallery'}</button><p>Removing from the gallery keeps your sharing setting. Use Share to make it private again.</p></form>
<form class="ovp-form" method="post" action="/i/${row.slug}/edit">
<label for="e-title">Title</label><input id="e-title" name="title" type="text" maxlength="120" value="${row.title}">
<label for="e-desc">Description</label><textarea id="e-desc" name="description" rows="3" maxlength="2000">${row.description}</textarea>
<label for="e-alt">Alt text</label><input id="e-alt" name="alt" type="text" maxlength="160" value="${row.alt || ''}" aria-describedby="e-alt-help">
<p class="muted" id="e-alt-help">What the picture shows, in one sentence, for people who cannot see it. Screen readers say it, and the embed snippets above carry it.${row.alt_source === 'ai' ? ' This one was written by AI: check it says what you want.' : ''}</p>
${labelsUi.picker(row, { what: 'the picture', id: 'e-labels' })}
<p><button class="ovp-btn ovp-btn--primary" type="submit">Save</button></p></form>
${describeOn && !hidden ? html`<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/describe"><button class="ovp-btn" type="submit">${row.ai_described_at ? 'Write it again with AI' : 'Write alt text with AI'}</button> <span class="muted">Sends this picture to OpenVibe.AI, which may use an outside model provider, to draft alt text, a caption and tags. Nothing of the picture is kept there.</span></form>` : ''}
${tagsOf(row).length ? html`<p class="muted">AI tags: ${tagsOf(row).join(', ')}</p>` : ''}
<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/album">
<label for="e-album">Add to an album</label>
<select id="e-album" name="album">${albums.map((a) => html`<option value="${a.slug}">${a.title}</option>`)}<option value="">A new album…</option></select>
<input name="new_title" type="text" maxlength="120" placeholder="New album name" aria-label="New album name">
<button class="ovp-btn" type="submit">Add</button></form>
${holding.length ? html`<p class="muted">In ${holding.map((a, i) => html`${i ? ', ' : ''}<a href="/a/${a.slug}">${a.title}</a>`)}.</p>` : ''}
<form class="ovp-form ovp-inline" method="post" action="/i/${row.slug}/delete" data-confirm="Delete this picture for good?"><button class="ovp-btn ovp-btn--danger" type="submit">Delete this picture</button> <span class="muted">Its page goes at once; copies other sites already loaded can show for up to ten minutes.</span></form>
</section>` : ''}
${!owner && !hidden ? html`<details class="ovp-report"><summary>Report this picture</summary>
<form class="ovp-form" method="post" action="/i/${row.slug}/report">
<fieldset><legend>What is wrong with it?</legend>
${pics.REASONS.map((r) => html`<label class="ovp-radio"><input type="radio" name="reason" value="${r}" required> ${pics.REASON_TEXT[r]}</label>`)}
</fieldset>
<label for="r-note">Anything staff should know (optional)</label><textarea id="r-note" name="note" rows="2" maxlength="500"></textarea>
<p><button class="ovp-btn" type="submit">Send the report</button> <span class="muted">Copyright owners can also send a notice through <a href="/dmca">the DMCA page</a>.</span></p>
</form></details>` : ''}`,
        }, status);
    }

    const commentFailure = (req, res, slug, detail, status = 422) => page(req, res, {
        title: 'Comment not sent', cache: cache.htmlHeaders({ private: true }),
        body: html`<h1>Comment not sent</h1><p>${detail}</p><p><a href="/i/${slug}#comments">Go back</a></p>`,
    }, status);
    r.post('/i/:slug/comments', mustSignIn('Sign in to comment.'), budgeted('pics.image.write'), commentMultipart, async (req, res) => {
        const { row, status } = await picture(req, res);
        if (!row || status !== 200) return notFound(req, res);
        if (!sameSite(req, res, `/i/${row.slug}`)) return undefined;
        if (!await sharing.canView({ kind: 'anonymous' }, 'picture', row.id)) return notFound(req, res);
        let form;
        try { form = await readCommentForm(req); }
        catch (err) { return commentFailure(req, res, row.slug, err.message); }
        const attachments = [];
        for (const file of form.files) {
            const uploaded = await comments.upload(row.id, req.viewer.token, Buffer.from(await file.arrayBuffer()), file.name, file.type);
            if (uploaded.status !== 201 || !uploaded.body.attachment) return commentFailure(req, res, row.slug, uploaded.body.detail || uploaded.body.error || 'The attachment could not be saved', uploaded.status);
            attachments.push(uploaded.body.attachment);
        }
        const result = await comments.add(row.id, req.viewer.token, { message: form.message, parent_id: form.parent_id, attachments });
        if (result.status !== 201) return commentFailure(req, res, row.slug, result.body.detail || result.body.error || 'The comment could not be saved', result.status);
        return res.redirect(303, `/i/${row.slug}?sort=${req.query.sort === 'new' ? 'new' : 'top'}#comments`);
    });
    r.post('/i/:slug/comments/delete', mustSignIn('Sign in to remove a comment.'), budgeted('pics.image.write'), async (req, res) => {
        const { row, status } = await picture(req, res);
        if (!row || status !== 200) return notFound(req, res);
        if (!sameSite(req, res, `/i/${row.slug}`)) return undefined;
        const id = String(req.body.comment_id || '');
        if (!/^\d{1,15}$/.test(id)) return commentFailure(req, res, row.slug, 'Invalid comment');
        let result;
        if (pics.isOwner(row, whoOf(req)) || (signedIn(req) && pics.isStaff(req.viewer))) {
            try { await commentModeration.remove(row, req.viewer.subject, true, id, req.ip); result = { status: 200 }; }
            catch (err) { result = { status: err.status || 503, body: { detail: err.message } }; }
        } else result = await comments.remove(id, req.viewer.token);
        if (result.status !== 200) return commentFailure(req, res, row.slug, result.body.detail || result.body.error || 'The comment could not be removed', result.status);
        return res.redirect(303, `/i/${row.slug}?sort=${req.query.sort === 'new' ? 'new' : 'top'}#comments`);
    });

    r.get('/i/:slug', async (req, res) => {
        const { row, status, denied } = await picture(req, res);
        if (denied && row) {
            const share = sharing ? await sharing.shareOf('picture', row.id).catch(() => null) : null;
            if (share && share.audience === 'people') {
                return page(req, res, {
                    title: 'A picture on OpenVibe.Pics', noindex: true,
                    body: html`<header class="ovp-page-head"><h1>A picture on OpenVibe.Pics</h1><p class="muted">This is shared with specific people.</p></header>
<div id="share-gate" data-ov-share-gate data-kind="picture" data-id="${String(row.id)}" data-signed-in-as="${req.viewer && req.viewer.username ? req.viewer.username : ''}" data-sign-in-url="${`/auth/login?next=${encodeURIComponent(req.originalUrl)}`}">
<p class="muted">This picture is shared with specific people on OpenVibe.Pics.</p><p>${signInLink(req.originalUrl)}</p></div>
<link rel="stylesheet" href="${ovServe.url('ov-share.css')}">
<script src="${ovServe.url('ov-share.js')}" defer></script>`,
                }, 404);
            }
        }
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
        const labels = labelsUi.fromForm(req.body);
        if (labels === null) return picturePage(req, res, row, { message: 'Choose the labels from the list.', tone: 'warn' }, 422);
        await pics.edit(row, { title: req.body.title, description: req.body.description, alt: req.body.alt, ...(labels !== undefined ? { labels } : {}) });
        return res.redirect(303, `/i/${row.slug}`);
    });

    r.post('/i/:slug/publication', mustSignIn('Sign in to publish your picture.'), budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return;
        const row = await ownPicture(req, res);
        if (!row) return;
        const out = await gallery.publish(ctx, row, req.viewer, { listed: req.body.listed === 'true', tags: String(req.body.tags || '').split(',').map((v) => v.trim()).filter(Boolean) });
        if (out.error) return picturePage(req, res, row, { message: out.error, tone: 'warn' }, 422);
        return res.redirect(303, `/i/${row.slug}`);
    });

    r.post('/i/:slug/describe', mustSignIn('Sign in to change your picture.'), budgeted('pics.image.describe'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const row = await ownPicture(req, res);
        if (!row) return undefined;
        const out = await ctx.picsDescribe.describe(row);
        if (!out.ok) return picturePage(req, res, row, { message: out.detail, tone: 'warn' }, out.status);
        return picturePage(req, res, out.row, { message: 'AI wrote the alt text below. Check it, change it if you like, and save.' });
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

    // A quarter turn by the person who uploaded the picture: plain kit buttons in the owner's section, a POST and a
    // redirect, so it works without JavaScript. The picture and its thumbnail both turn; every size follows.
    r.post('/i/:slug/rotate', budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const { row } = await picture(req, res);
        if (!row) return notFound(req, res);
        if (!pics.isOwner(row, whoOf(req))) return picturePage(req, res, row, { message: 'Only the person who uploaded this picture can turn it.', tone: 'warn' }, 403);
        const degrees = String(req.body.direction || '') === 'left' ? 270 : 90;
        const out = await pics.rotate(row, degrees, whoOf(req));
        if (!out.ok) return picturePage(req, res, row, { message: out.detail || 'The picture could not be turned.', tone: 'warn' }, out.status || 422);
        return res.redirect(303, `/i/${row.slug}?turned=1`);
    });

    r.post('/i/:slug/delete', budgeted('pics.image.write'), async (req, res) => {
        if (!sameSite(req, res, `/i/${req.params.slug}`)) return undefined;
        const { row } = await picture(req, res);
        const byKey = row && pics.deleteKeyMatches(row, String(req.body.key || ''));
        if (!row || !(pics.isOwner(row, whoOf(req)) || byKey)) return notFound(req, res);
        await pics.remove(row);
        return page(req, res, { title: 'Deleted', body: html`<h1>Deleted</h1><p>The picture is gone. Places that already showed it may keep a copy for up to ten minutes.</p><p><a class="ovp-btn ovp-btn--primary" href="/">Upload another</a>${signedIn(req) ? html` <a class="ovp-btn" href="/mine">Your pictures</a>` : ''}</p>` });
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
        const pictureDefault = await sharing.defaultAudience(owner, 'picture');
        return page(req, res, {
            title: 'Your pictures', styles: ['kit.css'], scripts: ['js/pics.js'],
            body: html`<div class="ovp-section-head"><h1>Your pictures</h1><span class="muted">${use.images} picture${use.images === 1 ? '' : 's'} · ${formatBytes(use.bytes)} of ${formatBytes(cfg.quotaBytes)}</span></div>
${uploadForm(req, { compact: true, defaultAudience: pictureDefault })}
<form class="ovp-form" method="post" action="/mine/share-default"><label>New pictures <select name="audience">${audienceOptions(pictureDefault)}</select></label><label><input type="checkbox" name="apply" value="1"> Apply to all my existing pictures</label><button class="ovp-btn" type="submit">Save default</button></form>
${grid(out.rows, { title: 'No pictures yet', text: 'Upload a picture above and it appears here.', action: { href: '/', label: 'Upload a picture', icon: 'image' } })}
${out.next ? html`<p><a class="ovp-btn" href="/mine?before=${out.next}">Older pictures</a></p>` : ''}`,
        });
    });

    r.post('/mine/share-default', mustSignIn('Sign in to change picture sharing.'), async (req, res) => {
        if (!sameSite(req, res, '/mine')) return;
        const audience = String(req.body.audience || '');
        if (!sharing.AUDIENCES.includes(audience)) return page(req, res, { title: 'Invalid audience', body: html`<h1>Choose a sharing audience</h1><p><a href="/mine">Back to your pictures</a></p>` }, 422);
        const owner = whoOf(req).requester;
        await sharing.setDefaultAudience(owner, 'picture', audience);
        if (req.body.apply === '1') await sharing.applyDefault(owner, 'picture', audience);
        return res.redirect(303, '/mine');
    });

    r.get('/albums', mustSignIn('Albums belong to your OpenVibe account.'), async (req, res) => {
        const owner = whoOf(req).requester;
        const albums = await store.albumsOf(s, owner);
        const albumDefault = await sharing.defaultAudience(owner, 'album');
        return page(req, res, {
            title: 'Your albums',
            body: html`<h1>Your albums</h1>
<form class="ovp-form ovp-inline" method="post" action="/albums"><label for="a-title">New album</label><input id="a-title" name="title" type="text" maxlength="120" required placeholder="Trip to the coast"><label>Who can open it <select name="audience">${audienceOptions(albumDefault)}</select></label><button class="ovp-btn ovp-btn--primary" type="submit">Create</button></form>
<form class="ovp-form" method="post" action="/albums/share-default"><label>New albums <select name="audience">${audienceOptions(albumDefault)}</select></label><label><input type="checkbox" name="apply" value="1"> Apply to all my existing albums</label><button class="ovp-btn" type="submit">Save default</button></form>
${albums.length ? html`<div class="ovp-albums">${albums.map((a) => html`<a class="ovp-album" href="/a/${a.slug}">${a.cover_slug ? html`<img src="/i/${a.cover_slug}/thumb.webp" alt="" loading="lazy">` : html`<span class="ovp-album-empty" aria-hidden="true"></span>`}<span class="ovp-album-title">${a.title}</span><span class="muted">${a.image_count} picture${Number(a.image_count) === 1 ? '' : 's'}</span></a>`)}</div>`
        : raw(kit.empty({ icon: 'image', title: 'No albums yet', text: 'Create one above, or add a picture to a new album from its page.', action: { href: '#a-title', label: 'Create an album', icon: 'plus' } }))}`,
            styles: ['kit.css'],
        });
    });

    r.post('/albums', mustSignIn('Sign in to use albums.'), budgeted('pics.album.create'), async (req, res) => {
        if (!sameSite(req, res, '/albums')) return undefined;
        const made = await pics.createAlbum(whoOf(req).requester, { title: req.body.title, audience: req.body.audience || undefined });
        if (!made.ok) return page(req, res, { title: 'Album', body: html`<h1>Your albums</h1>${notice(made.detail, 'warn')}<p><a href="/albums">Back</a></p>` }, made.status);
        return res.redirect(303, `/a/${made.album.slug}`);
    });

    r.post('/albums/share-default', mustSignIn('Sign in to change album sharing.'), async (req, res) => {
        if (!sameSite(req, res, '/albums')) return;
        const audience = String(req.body.audience || '');
        if (!sharing.AUDIENCES.includes(audience)) return page(req, res, { title: 'Invalid audience', body: html`<h1>Choose a sharing audience</h1><p><a href="/albums">Back to your albums</a></p>` }, 422);
        const owner = whoOf(req).requester;
        await sharing.setDefaultAudience(owner, 'album', audience);
        if (req.body.apply === '1') await sharing.applyDefault(owner, 'album', audience);
        return res.redirect(303, '/albums');
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
        if (!owner && sharing) {
            const share = await sharing.shareOf('album', album.id).catch(() => null);
            if (share && !await sharing.canView(req.viewer, 'album', album.id).catch(() => false)) return notFound(req, res);
        }
        const images = await store.albumImages(s, album.id, { visibleOnly: !owner });
        const rows = owner ? images : (await Promise.all(images.map(async (image) => await sharing.canView(req.viewer, 'picture', image.id) ? image : null))).filter(Boolean);
        return page(req, res, {
            title: album.title, noindex: true, styles: ['kit.css'], scripts: ['js/pics.js'],
            image: rows[0] ? `${base}/i/${rows[0].slug}.${rows[0].ext}` : undefined,
            body: html`<div class="ovp-section-head"><h1>${album.title}</h1><span class="muted">${rows.length} picture${rows.length === 1 ? '' : 's'}</span></div>
${album.description ? html`<p class="ovp-desc">${album.description}</p>` : ''}
${copyRow('Link to this album', `${base}/a/${album.slug}`, 'c-album')}
<p class="ovp-share">${raw(shareButton({ url: `${base}/a/${album.slug}`, title: album.title, text: album.description || `${album.title}: an album on ${SITE_NAME}.`, kind: 'album', id: album.id }))}</p>
${grid(rows, owner ? { title: 'No pictures in this album yet', text: 'Add pictures to it from your pictures page.', action: { href: '/mine', label: 'Your pictures', icon: 'image' } } : { title: 'Nothing to show yet', text: 'The owner has not added a picture here yet.' })}
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

    // ── The policy pages ────────────────────────────────────
    // What happens to a picture's hidden data, what may be put on the site, and what we do with pictures and AI.
    // Each page is built from the service's own configuration (server/pics/policy.js), so every number on them is one
    // the code enforces.
    for (const kind of ['exif', 'content-policy', 'ai-training']) {
        const spec = policyPage(kind, { cfg, reasons: pics.REASONS, reasonText: pics.REASON_TEXT });
        r.get(spec.path, (req, res) => page(req, res, {
            index: true, title: spec.title, description: spec.description,
            styles: ['kit.css'], sharedScripts: ['kit-web.js'],
            body: raw(`<div class="ovp-policy">${spec.body}</div>`),
        }));
    }

    // ── Discovery, legal, update log ────────────────────────
    r.get('/robots.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(`# openvibe.pics: only explicitly published pictures are indexed.\n${seo.robotsTxt({ sitemaps: [`${base}/sitemap.xml`], disallow: ['/a/', '/mine', '/albums', '/staff', '/api/', '/auth/', '/upload'] })}`));
    // The indexable pages: the home, the update log, the rules and the policy pages. No picture or album is ever listed.
    r.get('/sitemap.xml', async (_req, res) => res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
        .send(seo.sitemapXml(['/', '/updates', ...legal.PATHS, ...POLICY_PATHS].map((p) => ({ loc: `${base}${p}` })).concat((await s.db.many(`SELECT i.slug FROM pics_images i WHERE ${gallery.PUBLIC} ORDER BY i.published_at DESC LIMIT 50000`)).map((r) => ({ loc: `${base}/i/${r.slug}` }))))));
    // RFC 9116, canonical to this host (openvibe.pics).
    r.get('/.well-known/security.txt', securityTxt.handler(base));
    // The site as llms.txt describes it, shared by /llms.txt and /llms-full.txt (SEO-33). AGT-5: its own pages are
    // linked at their Markdown twins; `base` is this host's origin, so other sites' links keep theirs.
    const llmsSite = () => ({
        name: SITE_NAME,
        markdown: true,
        base,
        summary: 'Picture hosting on the OpenVibe network: upload a picture, get a link to share or embed, albums, any size or format.',
        details: 'Uploads use the person\'s audience choice, Everyone by default. Only explicitly published pictures appear in the public gallery. Each one is re-encoded with its metadata removed, and can be had resized and converted at /i/<slug>/w/<320|640|1280|1920|2560>.<webp|avif|jpg|png>. Alt text: the uploader writes it or asks OpenVibe.AI for a draft (POST /api/v1/images/<slug>/describe). API: POST /api/v1/images with the picture as the body (an OpenVibe sign-in token as a Bearer).',
        sections: [
            { title: 'Start here', links: [{ title: SITE_NAME, url: `${base}/` }] },
        ],
        // llmstxt.org's "## Optional": what an agent may skip when it needs a shorter context.
        optional: [
            { title: 'What happens to your picture', url: `${base}/exif` },
            { title: 'What you may put here', url: `${base}/content-policy` },
            { title: 'Pictures and AI', url: `${base}/ai-training` },
            { title: 'Terms', url: `${base}/terms` },
            { title: 'DMCA', url: `${base}/dmca` },
            { title: 'Sitemap', url: `${base}/sitemap.xml`, note: 'home, policies and explicitly published pictures' },
            { title: 'Full text for language models', url: `${base}/llms-full.txt` },
        ],
    });
    // /.well-known/agent.json on the Pics host (SEO-2): its own manifest, not the drive's or the video host's.
    r.get('/.well-known/agent.json', (_req, res) => res.type('application/json').set('Cache-Control', 'public, max-age=3600')
        .send(JSON.stringify(require('openvibe-shared/agent-layer').agentManifest(require('./agent-descriptor')))));
    r.get('/llms.txt', (_req, res) => res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt(llmsSite())));
    // The same, in full (SEO-33): what the site is, then every page llms.txt lists with what it holds.
    r.get('/llms-full.txt', (_req, res) => {
        const d = llmsSite();
        res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsFull({
            site: d.name, summary: d.summary, base: `${base}/`,
            sections: [
                { title: 'About', pages: [{ title: d.name, url: `${base}/`, text: [d.summary, Array.isArray(d.details) ? d.details.join('\n') : d.details].filter(Boolean).join('\n\n') }] },
                ...(d.sections || []).map((x) => ({ title: x.title, pages: (x.links || []).map((l) => ({ title: l.title, url: l.url, text: l.note || '' })) })),
                // AGT-5: the Optional links are still pages, so the full document names them too.
                ...((d.optional || []).length ? [{ title: 'Optional', pages: d.optional.map((l) => ({ title: l.title, url: l.url, text: l.note || '' })) }] : []),
            ],
        }));
    });
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
