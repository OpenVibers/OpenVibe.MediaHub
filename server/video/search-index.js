'use strict';
/**
 * OpenVibe.Video uploads in OpenVibe.Search: every public, ready upload is one document (search.index-document@1,
 * owner media-hub, type video, id = the vup_ id, /u/<id>), written through Search's owner API with MediaHub's service
 * token (search.document.write on openvibe.search; Events cannot carry it, an event type has no hyphen). An upload
 * that is made private or unlisted, hidden after reports, removed or deleted is tombstoned.
 *
 * Runs a minute after boot and every hour, and 30 seconds after a change (kick()). Search's listing gives the stored
 * revisions; a document is re-sent one revision up only when its content hash differs from the last one sent
 * (video_search_state, migration 0013), so a quiet hour costs one listing.
 *
 * Off unless MEDIAHUB_SEARCH_URL and the OAuth client secret are set (MEDIAHUB_VIDEO_SEARCH=off turns it off).
 */
const crypto = require('crypto');
const { serviceAuth } = require('openvibe-contracts');

const OWNER = 'media-hub';
const TYPE = 'video';
const EVERY_MS = 60 * 60 * 1000;
const KICK_MS = 30 * 1000;

const hashOf = (doc) => crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');

/** An upload row (and its AI edit, when done) → the document body; identity and revision are added by the caller. */
function documentFor(row, { videoUrl, ai = null }) {
    const channel = row.owner_username || null;
    const overview = ai && ai.status === 'done' && ai.overview ? String(ai.overview) : '';
    const transcript = ai && ai.status === 'done' && Array.isArray(ai.segments) ? ai.segments.map((x) => x.text).join(' ') : '';
    return {
        visibility: 'public',
        canonical_url: `${videoUrl}/u/${row.id}`,
        title: String(row.title || 'Video').slice(0, 500),
        summary: String(row.description || overview || (channel ? `A video by @${channel} on OpenVibe.Video.` : 'A video on OpenVibe.Video.')).slice(0, 4000),
        body: [row.title, row.description, overview, transcript.slice(0, 20000)].filter(Boolean).join('\n').slice(0, 48000),
        facets: { kind: 'upload', ...(channel ? { channel } : {}), ...(row.duration_seconds ? { minutes: Math.max(1, Math.round(Number(row.duration_seconds) / 60)) } : {}) },
        authorship: 'human',
        publication_state: 'published',
        published_at: row.ready_at || row.created_at || null,
        updated_at: row.updated_at || null,
        indexability: { decision: 'index', reasons: [] },
    };
}

function createVideoSearchIndex({ s, config, videoAi = null, fetchImpl = globalThis.fetch, log = console, tokens = null }) {
    const url = String((config.search && config.search.url) || '').replace(/\/+$/, '');
    const enabled = Boolean(url && (tokens || config.oauth.clientSecret) && !(config.search && config.search.videoOff));
    const auth = tokens || (enabled ? serviceAuth.createTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.search', scope: 'search.document.write', fetchImpl,
    }) : null);
    const videoUrl = String(config.video.url).replace(/\/+$/, '');
    const stats = { runs: 0, upserted: 0, deleted: 0, unchanged: 0, failed: 0, last_run_at: null, last_error: null };

    async function call(method, p, body) {
        const res = await fetchImpl(`${url}${p}`, {
            method,
            headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(await auth.authHeaders()) },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(15000),
        });
        const json = await res.json().catch(() => ({}));
        if (res.status === 401 && auth.invalidate) auth.invalidate();
        return { status: res.status, ok: res.ok, body: json };
    }

    async function remoteDocs() {
        const out = new Map();
        let after = 0;
        for (let i = 0; i < 100; i++) {
            const r = await call('GET', `/api/v1/owners/${OWNER}/documents?type=${TYPE}&limit=1000&after=${after}`);
            if (!r.ok) throw new Error(`listing: ${r.status} ${r.body.code || ''}`);
            for (const d of r.body.documents || []) out.set(d.id, d);
            if (!r.body.next_after) break;
            after = r.body.next_after;
        }
        return out;
    }

    async function run() {
        if (!enabled) return null;
        stats.runs++;
        stats.last_run_at = new Date(s.now()).toISOString();
        const listed = await s.db.many("SELECT * FROM video_uploads WHERE visibility = 'public' AND status = 'ready' AND state = 'active' ORDER BY id");
        const sent = new Map((await s.db.many('SELECT id, hash FROM video_search_state')).map((r) => [r.id, r.hash]));
        const remote = await remoteDocs();
        const keep = new Set();
        for (const row of listed) {
            keep.add(row.id);
            const ai = videoAi && videoAi.forUpload ? await videoAi.forUpload(row).catch(() => null) : null;
            const doc = documentFor(row, { videoUrl, ai });
            const h = hashOf(doc);
            const r = remote.get(row.id);
            if (r && !r.deleted && sent.get(row.id) === h) { stats.unchanged++; continue; }
            const revision = r ? Number(r.revision) + 1 : 1;
            const res = await call('PUT', `/api/v1/documents/${OWNER}/${TYPE}/${row.id}`, { ...doc, revision });
            if (res.ok) {
                await s.db.exec(`INSERT INTO video_search_state (id, hash, revision, updated_at) VALUES ($1, $2, $3, $4)
                                 ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, revision = excluded.revision, updated_at = excluded.updated_at`,
                [row.id, h, revision, s.iso()]);
                stats.upserted++;
            } else {
                stats.failed++;
                stats.last_error = `${row.id}: ${res.status} ${res.body.code || ''}`;
            }
        }
        for (const [id, r] of remote) {
            if (keep.has(id) || r.deleted) continue;
            const res = await call('DELETE', `/api/v1/documents/${OWNER}/${TYPE}/${encodeURIComponent(id)}?revision=${Number(r.revision) + 1}`);
            if (res.ok) {
                await s.db.exec('DELETE FROM video_search_state WHERE id = $1', [id]);
                stats.deleted++;
            } else {
                stats.failed++;
                stats.last_error = `${id}: ${res.status} ${res.body.code || ''}`;
            }
        }
        return { ...stats };
    }

    const quietly = () => run().catch((err) => { stats.failed++; stats.last_error = err.message; log.warn('[OpenVibe.Video] search index run failed:', err.message); });
    let timer = null;
    let first = null;
    let kicked = null;
    return {
        enabled,
        run,
        stats: () => ({ ...stats }),
        /** A change happened (an upload edited, deleted or reported): run soon, once for a burst of changes. */
        kick() {
            if (!enabled || kicked) return;
            kicked = setTimeout(() => { kicked = null; quietly(); }, KICK_MS);
            if (kicked.unref) kicked.unref();
        },
        start({ firstDelayMs = 60_000 } = {}) {
            if (!enabled || timer) return;
            first = setTimeout(quietly, firstDelayMs);
            if (first.unref) first.unref();
            timer = setInterval(quietly, EVERY_MS);
            if (timer.unref) timer.unref();
        },
        stop() {
            clearTimeout(first); clearInterval(timer); clearTimeout(kicked);
            timer = null; first = null; kicked = null;
        },
    };
}

module.exports = { createVideoSearchIndex, documentFor };
