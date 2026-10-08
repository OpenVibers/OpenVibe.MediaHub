'use strict';

/**
 * OpenVibe.MediaHub configuration. Every value comes from the environment (production: /etc/openvibe/media-hub.env, see
 * .env.example). Only environment variable NAMES appear in code and docs; secrets are never logged.
 *
 * load(env) is pure so tests can build a config without touching process.env.
 */
require('dotenv').config();
const trim = (s) => String(s || '').replace(/\/+$/, '');
const int = (v, def) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : def);
const size = (v, def) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : def);

// The per-person numbers of a private drive (bytes, files, uploads, shares). Every one of them comes from the
// environment: they are the product's policy, not a constant somebody has to edit to change.
const GB = 1024 ** 3;
const MB = 1024 ** 2;

function load(env = process.env) {
    const nodeEnv = env.NODE_ENV || 'development';
    const isProduction = nodeEnv === 'production';
    const port = int(env.PORT, 4990);
    const baseUrl = trim(env.BASE_URL || (isProduction ? 'https://openvibe.download' : `http://localhost:${port}`));
    const networkUrl = trim(env.OV_NETWORK_URL || 'https://openvibe.network');

    return {
        service: 'media-hub',
        port,
        host: env.HOST || '127.0.0.1',
        nodeEnv,
        isProduction,
        baseUrl,
        trustProxy: env.TRUST_PROXY != null ? Number(env.TRUST_PROXY) : 2,
        // Per-caller limits (server/http/caller-limits.js): the requests one caller (an app, a person, else an
        // address) may make per minute and per hour. The product's own routes add tighter budgets there.
        limits: {
            minute: Math.max(1, int(env.MEDIAHUB_LIMITS_MINUTE, 120)),
            hour: Math.max(1, int(env.MEDIAHUB_LIMITS_HOUR, 3000)),
        },

        // PostgreSQL (ADR-035): DATABASE_URL serves (PgBouncer), DATABASE_DIRECT_URL migrates (owner role). In
        // development without DATABASE_URL an embedded PGlite database in data/pglite is used (MEDIAHUB_PGLITE_DIR
        // overrides the directory).
        db: { url: env.DATABASE_URL || '', directUrl: env.DATABASE_DIRECT_URL || '', pgliteDir: env.MEDIAHUB_PGLITE_DIR || '' },
        valkey: { url: env.VALKEY_URL || '', prefix: env.VALKEY_PREFIX || 'ov:media-hub:' },

        // OpenVibe.Media: the only place bytes live. MediaHub talks to it server-side with its own app key
        // (Media's `:app` segment `media-hub`); no browser ever holds that key. MEDIAHUB_MEDIA_URL is the
        // host-internal address (127.0.0.1:4100 in production), never the public origin.
        media: {
            url: trim(env.MEDIAHUB_MEDIA_URL || 'http://127.0.0.1:4100'),
            app: env.MEDIAHUB_MEDIA_APP || 'media-hub',
            appKey: env.MEDIAHUB_MEDIA_APP_KEY || '',
            timeoutMs: int(env.MEDIAHUB_MEDIA_TIMEOUT_MS, 30_000),
        },

        // What one person may keep and do here. Media's own quotas are per tenant (this whole service is one
        // tenant), so the per-person numbers are enforced in MediaHub and nowhere else.
        quotas: {
            bytes: size(env.MEDIAHUB_QUOTA_BYTES, 2 * GB),              // 2 GB stored
            maxFileBytes: size(env.MEDIAHUB_MAX_FILE_BYTES, 512 * MB),  // 512 MB per file
            uploadsPerDay: size(env.MEDIAHUB_UPLOADS_PER_DAY, 50),      // 50 uploads a day (UTC)
            maxShares: size(env.MEDIAHUB_MAX_SHARES, 20),               // 20 live share links
        },
        // A plain <input type=file> form posts the whole file in one request; past this the page offers the
        // chunked upload (script). Both are capped by quotas.maxFileBytes.
        singleUploadBytes: size(env.MEDIAHUB_SINGLE_UPLOAD_BYTES, 256 * MB),
        // Media requires parts of at least 5 MB and at most 256 MB; ours sits between, so an operator cannot
        // configure a part size Media will refuse.
        partBytes: Math.min(256 * MB, Math.max(5 * MB, size(env.MEDIAHUB_PART_BYTES, 8 * MB))),
        uploadTtlSeconds: size(env.MEDIAHUB_UPLOAD_TTL_SECONDS, 6 * 3600),
        // Where a no-JavaScript upload is spooled before it goes to Media. Never served, never listed.
        tmpDir: env.MEDIAHUB_TMP_DIR || '',

        // OpenVibe.Events: the ADR-033 account export/deletion events (network.account.export_requested and
        // network.account.deleted). Without the secret the route answers 503 and Network retries.
        events: {
            secrets: [env.MEDIAHUB_EVENTS_SECRET, env.OV_EVENTS_SECRET].filter(Boolean).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean),
            // Where the two ADR-033 subscriptions are created at boot (server/events-consumer.js); off when unset.
            url: String(env.MEDIAHUB_EVENTS_URL || env.EVENTS_URL || '').replace(/\/+$/, ''),
            endpoint: env.MEDIAHUB_EVENTS_ENDPOINT || '',
        },

        // OpenVibe.Network: SSO (OAuth2 authorization server with PKCE) and its JWKS.
        networkUrl,
        networkInternalUrl: trim(env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000'),
        networkIssuer: trim(env.OV_NETWORK_ISSUER || networkUrl),
        // The audience this service's app, agent and service tokens carry.
        audience: env.MEDIAHUB_AUDIENCE || 'openvibe.download',
        oauth: {
            clientId: env.OV_OAUTH_CLIENT_ID || 'media-hub',
            clientSecret: env.OV_OAUTH_CLIENT_SECRET || '',
            redirectUri: env.OV_OAUTH_REDIRECT_URI || `${baseUrl}/auth/callback`,
            scope: 'profile',
            sessionAudience: env.OV_SESSION_AUDIENCE || 'openvibe.network',
        },
        cookies: { secure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction },
    };
}

module.exports = { load };
