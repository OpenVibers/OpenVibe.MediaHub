'use strict';

/**
 * OpenVibe.MediaHub — Express app factory; server/index.js listens, tests build their own instance with a temp database
 * and a mock Network.
 *
 *   /, /updates                                       the pages (http/pages.js)
 *   /api/v1/*                                         the API (http/api.js)
 *   /auth/*                                           Network SSO with PKCE (auth/sso.js)
 *   /api/health, /api/ready, /release.json, /metrics  (loopback only)
 *
 * The product fills this in: its routes in http/api.js, its pages in http/pages.js, its capabilities in
 * http/principal.js and its budgets in http/caller-limits.js. The plumbing here (helmet, SSO, legal pages,
 * static assets, the API mount, the 404 and the error handler) stays.
 */
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const contracts = require('openvibe-contracts');
const cache = require('openvibe-shared/cache-policy');

const configLib = require('./config');
const { openStore } = require('./db');
const { createKeyStore } = require('./auth/keys');
const { createSso } = require('./auth/sso');
const { createPrincipal } = require('./http/principal');
const { createApi } = require('./http/api');
const { createPageRoutes } = require('./http/pages');
const { createVideoRoutes } = require('./video/pages');
const { createServiceReadiness } = require('./observability');
const { createCallerLimits } = require('./http/caller-limits');
const { assetVersion, send } = require('./render/layout');
const { html } = require('./render/html');
const store = require('./drive/store');
const { createMediaClient } = require('./media/client');
const { createIdentity } = require('./network/identity');
const { createService } = require('./drive/service');
const { createUploads } = require('./drive/upload');
const { createAccount, createSender } = require('./account');
const { createPlaylists } = require('./video/playlists');
const { createIndexNow } = require('openvibe-shared/indexnow');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const VERSION = require('../package.json').version;
const { createHttpTelemetry } = require('openvibe-sdk/service');
const { createPgTelemetrySink } = require('openvibe-sdk/telemetry');

/**
 * opts: config, store, now (clock), fetchImpl (Network), log, limitsNow, callerLimits (false: count nobody,
 * tests only), valkey
 */
async function createApp(opts = {}) {
    const config = opts.config || configLib.load();
    const log = opts.log || console;
    const fetchImpl = opts.fetchImpl || globalThis.fetch;
    const s = opts.store || await openStore(config, { now: opts.now, log });

    const keys = createKeyStore({ config, fetchImpl, log });
    const sso = createSso({ config, keys, fetchImpl, now: s.now, log });
    const principal = createPrincipal({ config, keys });
    // The product: bytes in OpenVibe.Media, the drive's own rules, and the two upload flows.
    const media = createMediaClient({ config, fetchImpl, log });
    const identity = createIdentity({ config, fetchImpl, log });
    const drive = createService({ s, media, identity, config, log });
    const uploads = createUploads({ s, media, config, service: drive, log });
    const account = createAccount({ db: s.db, config, media, log });
    const playlists = createPlaylists({ s, config, log });
    const ctx = { config, s, store, keys, sso, principal, media, identity, drive, uploads, account, playlists, fetchImpl, log };
    // IndexNow for openvibe.video: off without a key; a malformed key warns and stays off rather than stopping the site.
    ctx.indexnow = opts.indexnow || (() => {
        const warn = (...a) => (log.warn || console.warn)(...a);
        try { return createIndexNow({ host: config.video.url, key: config.video.indexnowKey, fetch: fetchImpl, log: warn }); } catch (err) {
            warn(`[MediaHub] ${err.message} — IndexNow is off until INDEXNOW_KEY is fixed`);
            return createIndexNow({ host: config.video.url, key: '', fetch: fetchImpl, log: warn });
        }
    })();

    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.trustProxy);
    const release = require('openvibe-shared/release').createRelease({ service: 'media-hub', root: path.join(__dirname, '..') });
    require('./render/layout').setRelease(release.release);
    const metrics = require('openvibe-shared/metrics').instrument(app, { service: 'media-hub', release: release.release });
    app.locals.metrics = metrics.registry;
    // Request telemetry (openvibe-sdk/service, plan T1): one aggregated sample per route template, method and status
    // class each flush, stored in this service's telemetry_samples table; /shared, health, readiness and /metrics make
    // none. server/index.js flushes it on stop and keeps the table to 30 days.
    ctx.telemetry = createHttpTelemetry({ service: 'media-hub', sink: opts.telemetrySink || createPgTelemetrySink({ db: s.db, log }), skipPrefixes: ['/shared'] });
    app.use(ctx.telemetry.middleware());
    app.locals.ctx = ctx;
    const valkey = opts.valkey !== undefined ? opts.valkey : (config.valkey.url ? require('openvibe-sdk/valkey').createValkey({ url: config.valkey.url, prefix: config.valkey.prefix, log }) : null);
    ctx.valkey = valkey;
    ctx.limits = createCallerLimits({ config, now: opts.limitsNow || (() => Date.now()), registry: metrics.registry, log, enabled: opts.callerLimits !== false, valkey });

    app.use(contracts.http.middleware());
    const MEDIA_ORIGINS = ['https://openvibe.media', 'https://edge.openvibe.media', 'https://*.r2.cloudflarestorage.com', 'https://*.backblazeb2.com'];
    const liveOrigin = (() => { try { return new URL(config.video.livePublicUrl).origin; } catch { return 'https://openvibe.live'; } })();
    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The OpenVibe Frame (theme-loader, navbar, footer) comes from the Network; the inline init is ours.
                scriptSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://static.cloudflareinsights.com'],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://openvibe.network', 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
                fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
                imgSrc: ["'self'", 'data:', 'https://openvibe.network', 'https://openvibe.media'],
                // The video player loads its media file from OpenVibe.Media (https://openvibe.media/v|/c), which may
                // redirect to its shield host (edge.openvibe.media, for B2 copies) or a presigned R2/B2 URL, exactly
                // as on OpenVibe.Live. Over HLS it plays through Media Source Extensions (blob:) and fetches the
                // playlist and segments from openvibe.media.
                mediaSrc: ["'self'", 'blob:', ...MEDIA_ORIGINS],
                // The watch page counts a view on OpenVibe.Live with a beacon (Live's /api/views).
                connectSrc: ["'self'", 'https://openvibe.network', 'https://cloudflareinsights.com', 'https://openvibe.events', ...MEDIA_ORIGINS, liveOrigin],
                frameSrc: ["'self'", 'https://openvibe.network'],
                frameAncestors: ["'none'"],
                objectSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'", 'https://openvibe.network'],
            },
        },
        frameguard: { action: 'deny' },
        crossOriginEmbedderPolicy: false,
        crossOriginResourcePolicy: { policy: 'same-site' },
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }));
    app.use(cookieParser());

    // ── Who is asking (verified offline; refreshed when expired) ──
    // Mounted before the host routing so both openvibe.download and openvibe.video see req.viewer; the video
    // pages use it for the signed-in navbar and their private, no-store cache rule.
    app.use(sso.middleware());

    // ── Sign-in (OAuth2 + PKCE client of OpenVibe.Network) ──
    // Mounted before the host routing too: both hosts sign in through the same routes, and createSso picks the
    // callback URI from the Host header (the drive's, or the video host's).
    app.use('/auth/', rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false }));
    app.use('/auth', sso.routes());

    // /release.json (and loopback /metrics) answer on both hosts: the shared release check on openvibe.video reads its own
    // origin's /release.json, and so does the host's browser watch.
    release.mount(app, { registry: metrics.registry });

    // ── Host routing: openvibe.video is OpenVibe.Video; every other host (openvibe.download) stays
    // the drive. On the video host the drive's pages, API and legal pages never answer.
    const videoHost = (() => { try { return new URL(config.video.url).hostname; } catch { return null; } })();
    const videoRoutes = createVideoRoutes(ctx);
    // GET /<key>.txt on the video host: IndexNow's key file, only when a key is configured.
    if (ctx.indexnow.enabled) app.use((req, res, next) => (videoHost && req.hostname === videoHost ? ctx.indexnow.keyFile(req, res, next) : next()));
    app.use((req, res, next) => {
        if (videoHost && req.hostname === videoHost) return videoRoutes(req, res, next);
        return next();
    });

    // ── Machine endpoints ───────────────────────────────────
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'openvibe-media-hub', version: VERSION }));
    const readiness = createServiceReadiness({ s, config, release: release.release, valkey });
    app.get('/api/ready', readiness.handler);

    // ── Account export and deletion (ADR-033) ───────────────
    // Mounted before every body parser: the Events signature covers the raw bytes. It refuses anything that came
    // through a proxy, so only loopback can reach it even though nginx proxies this path.
    app.use('/internal/events', account.consumer({ send: createSender({ config, fetchImpl }) }));

    { const legal = require('openvibe-shared/legal'); app.get(legal.PATHS, legal.handler({ id: 'media-hub', service: 'media-hub', host: 'openvibe.download', name: 'OpenVibe.MediaHub', profile: 'ugc' })); }

    // ── Static assets (content-hashed ?v= → immutable) ──────
    app.use('/shared', require('openvibe-shared/serve').handler());
    app.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── API ─────────────────────────────────────────────────
    app.use('/api/v1', rateLimit({ windowMs: 60_000, limit: Number(process.env.MEDIAHUB_API_RATE_LIMIT_PER_MIN) || 240, standardHeaders: true, legacyHeaders: false, handler: (req, res) => contracts.http.sendProblem(res, 429, 'rate_limited', { detail: 'too many requests from this address; retry shortly', ctx: req.ov }) }));
    app.use('/api/v1', createApi(ctx));
    app.use('/api', (req, res) => contracts.http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));

    // ── Pages ───────────────────────────────────────────────
    app.use(rateLimit({ windowMs: 60_000, limit: Number(process.env.MEDIAHUB_RATE_LIMIT_PER_MIN) || 300, standardHeaders: true, legacyHeaders: false }));
    app.use(createPageRoutes(ctx));
    app.use((req, res) => send(res, 404, { viewer: req.viewer, config, path: req.originalUrl, title: 'Not found', body: html`<h1>Not found</h1><p>No page here. Try <a href="/">the home page</a> or <a href="/updates">the update log</a>.</p>` }));

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
        // Never log request bodies.
        log.error('[OpenVibe.MediaHub]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return;
        res.set('Cache-Control', cache.htmlHeaders({ private: true }));
        if (err && err.type === 'entity.parse.failed') return contracts.http.sendProblem(res, 400, 'request.malformed_json', { ctx: req.ov });
        if (err && err.type === 'entity.too.large') return req.path.startsWith('/api/') ? contracts.http.sendProblem(res, 413, 'request.too_large', { ctx: req.ov }) : res.status(413).type('text/plain').send('That request was too large.');
        if (req.path.startsWith('/api/')) return contracts.http.sendProblem(res, 500, 'internal.error', { detail: 'Internal error', ctx: req.ov });
        res.status(500).type('text/plain').send('Something went wrong on our side. Try again in a moment.');
    });

    return { app, ctx };
}

module.exports = { createApp };
