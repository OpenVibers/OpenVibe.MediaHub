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

        // OpenVibe.Media: the only place bytes live. MediaHub talks to it server-side with its Network service
        // token (Media's `:app` segment `media-hub`); no browser ever holds it. MEDIAHUB_MEDIA_URL is the
        // host-internal address (127.0.0.1:4100 in production), never the public origin.
        media: {
            url: trim(env.MEDIAHUB_MEDIA_URL || 'http://127.0.0.1:4100'),
            app: env.MEDIAHUB_MEDIA_APP || 'media-hub',
            timeoutMs: int(env.MEDIAHUB_MEDIA_TIMEOUT_MS, 30_000),
        },

        // OpenVibe.Video: public, read-only watch pages for OpenVibe.Live's stream recordings and clips. The
        // app serves openvibe.video by Host header and reads Live's public JSON API server-side, signed out.
        // `url` is the public origin (its hostname is the video host); `liveUrl` is where the app calls Live
        // (production sets it to the loopback address), `livePublicUrl` is what links people click, and
        // `chatUrl` is where it reads a stream's chat replay (production sets it to the loopback address).
        video: {
            url: trim(env.MEDIAHUB_VIDEO_URL || 'https://openvibe.video'),
            liveUrl: trim(env.MEDIAHUB_LIVE_URL || 'https://openvibe.live'),
            livePublicUrl: trim(env.MEDIAHUB_LIVE_PUBLIC_URL || 'https://openvibe.live'),
            chatUrl: trim(env.MEDIAHUB_CHAT_URL || 'https://openvibe.live'),
            // Playlists (step C): the per-person caps the pages and the API enforce together.
            playlistsMax: size(env.MEDIAHUB_VIDEO_PLAYLISTS_MAX, 100),
            playlistItemsMax: size(env.MEDIAHUB_VIDEO_PLAYLIST_ITEMS_MAX, 500),
            // IndexNow (server/video/indexnow.js): with a key, new watch pages are sent to search engines and the key
            // is served at https://openvibe.video/<key>.txt. Unset: off.
            indexnowKey: String(env.INDEXNOW_KEY || '').trim(),
        },

        // Drops (server/drive/drops.js): files uploaded to openvibe.download without an account (the owner's Q10), each
        // with a public /d/<slug> page and a delete key, kept 30 days after the last download. Off until the DMCA agent
        // and the CSAM hash-matching account exist (plan T10, with Pics' signed-out uploads): MEDIAHUB_DOWNLOAD_ANONYMOUS=1.
        drops: {
            enabled: env.MEDIAHUB_DOWNLOAD_ANONYMOUS === '1',
            maxBytes: size(env.MEDIAHUB_DROP_MAX_BYTES, 2 * GB),
            perDay: size(env.MEDIAHUB_DROPS_PER_DAY, 10),            // drops a day per address
            bytesPerDay: size(env.MEDIAHUB_DROP_BYTES_PER_DAY, 10 * GB),
            idleDays: Math.max(1, size(env.MEDIAHUB_DROP_IDLE_DAYS, 30)),
        },

        // OpenVibe.Pics (server/pics): picture hosting on openvibe.pics, chosen by Host header like the video host.
        // The bytes are private Media objects, re-encoded here with their metadata stripped and served only through
        // this service (/i/<slug>.<ext>). Signed-out uploads stay off until the DMCA agent and the CSAM
        // hash-matching account exist (plan T10 gate, owner items O25 and the CSAM tool account): `anonymous` is
        // MEDIAHUB_PICS_ANONYMOUS=1 then.
        // OpenVibe.AI (server/video/ai-edit.js): media.analyze on finished uploads, for captions, chapters and a summary.
        // Off without OV_AI_INTERNAL_URL, or with VIDEO_AI_ANALYSIS=off.
        ai: {
            internalUrl: trim(env.OV_AI_INTERNAL_URL || ''),
            videoAnalysis: env.VIDEO_AI_ANALYSIS !== 'off',
        },
        // Uploads on openvibe.video (server/video/uploads.js): the bytes are OpenVibe.Media VODs in this tenant.
        videoUploads: {
            maxBytes: size(env.VIDEO_UPLOAD_MAX_BYTES, 2 * GB),
            quotaBytes: size(env.VIDEO_UPLOAD_QUOTA_BYTES, 20 * GB),
            perDay: Math.max(1, size(env.VIDEO_UPLOADS_PER_DAY, 10)),
        },
        pics: {
            url: trim(env.MEDIAHUB_PICS_URL || 'https://openvibe.pics'),
            maxImageBytes: size(env.MEDIAHUB_PICS_MAX_IMAGE_BYTES, 20 * MB),
            maxPixels: size(env.MEDIAHUB_PICS_MAX_PIXELS, 100_000_000),
            quotaBytes: size(env.MEDIAHUB_PICS_QUOTA_BYTES, 5 * GB),
            imagesPerDay: size(env.MEDIAHUB_PICS_IMAGES_PER_DAY, 200),
            albumsMax: size(env.MEDIAHUB_PICS_ALBUMS_MAX, 200),
            albumImagesMax: size(env.MEDIAHUB_PICS_ALBUM_IMAGES_MAX, 500),
            reportsToHide: Math.max(1, size(env.MEDIAHUB_PICS_REPORTS_TO_HIDE, 3)),
            anonymous: env.MEDIAHUB_PICS_ANONYMOUS === '1',
            anonymousMaxImageBytes: size(env.MEDIAHUB_PICS_ANONYMOUS_MAX_IMAGE_BYTES, 10 * MB),
            anonymousPerDay: size(env.MEDIAHUB_PICS_ANONYMOUS_PER_DAY, 20),
            // A signed-out upload is deleted after this many days without a view.
            anonymousIdleDays: Math.max(1, size(env.MEDIAHUB_PICS_ANONYMOUS_IDLE_DAYS, 30)),
        },

        // What one person may keep and do here. Media's own quotas are per tenant (this whole service is one
        // tenant), so the per-person numbers are enforced in MediaHub and nowhere else.
        quotas: {
            bytes: size(env.MEDIAHUB_QUOTA_BYTES, 25 * GB),             // 25 GB stored (the owner's Q10: free accounts)
            maxFileBytes: size(env.MEDIAHUB_MAX_FILE_BYTES, 2 * GB),    // 2 GB per file
            uploadsPerDay: size(env.MEDIAHUB_UPLOADS_PER_DAY, 50),      // 50 uploads a day (UTC)
            syncUploadsPerDay: size(env.MEDIAHUB_SYNC_UPLOADS_PER_DAY, 1000),   // uploads a day through sync keys (backups)
            syncKeys: size(env.MEDIAHUB_SYNC_KEYS_MAX, 10),               // live sync keys per person
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
