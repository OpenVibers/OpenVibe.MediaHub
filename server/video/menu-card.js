'use strict';

/**
 * The menu's network card for OpenVibe.Video (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
 *
 * Video publishes "Trending": the most viewed public recordings and clips of the last seven days, each linking
 * to its openvibe.video watch page. The rows come from Live's public Content feed (GET /api/content/feed with
 * sort=top&window=week), which merges Media's public VODs and clips and already drops private, unlisted and
 * banned-account items; this module only picks the top six, merges the two lists and builds the card.
 *
 * The file is public and CORS *, cached for two minutes. A failed feed keeps the last good card; with none yet it
 * answers 503, and Network keeps the site's previous card for its own 30-minute window.
 */
const SITE = 'media-hub';
const CARD_ID = 'trending';
const BASE = 'https://openvibe.video';
const CARD_TTL_S = 300;
const CACHE_MS = 120_000;
const LIMIT = 6;

/** Plain words for a card: markup and control characters out, one line, within the schema's limit. */
function plain(value, max) {
    return String(value == null ? '' : value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
}

const views = (item) => (Number.isFinite(Number(item && item.views)) ? Number(item.views) : 0);

/** The card itself, most viewed first. `items` are feed items ({ kind, id, title, views }). */
function cardFrom(items, at = Date.now()) {
    const seen = new Set();
    const rows = (Array.isArray(items) ? items : [])
        .filter((it) => it && (it.kind === 'vod' || it.kind === 'clip') && Number.isSafeInteger(Number(it.id)) && Number(it.id) > 0 && views(it) > 0)
        .filter((it) => {
            const key = `${it.kind}:${it.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => views(b) - views(a))
        .slice(0, LIMIT)
        .map((it) => {
            const n = views(it);
            return {
                title: plain(it.title || (it.kind === 'clip' ? 'Clip' : 'Stream recording'), 80),
                meta: `${n.toLocaleString('en-US')} ${n === 1 ? 'view' : 'views'} this week`,
                url: `${BASE}/${it.kind === 'clip' ? 'c' : 'v'}/${Number(it.id)}`,
            };
        });
    return {
        id: CARD_ID,
        site: SITE,
        title: 'Trending',
        kind: 'rows',
        items: rows,
        more: { label: 'Watch more', url: `${BASE}/` },
        updated_at: new Date(at).toISOString(),
        ttl_s: CARD_TTL_S,
    };
}

/**
 * The route. `feed` is Live's client's feed({ type, limit, sort, window }); `now` is injectable for the test.
 */
function createMenuCardHandler({ feed, now = Date.now }) {
    let cached = null;
    let cachedAt = 0;
    let pending = null;

    async function card() {
        const at = now();
        if (cached && at - cachedAt < CACHE_MS) return cached;
        if (pending) return pending;
        pending = (async () => {
            try {
                const [vods, clips] = await Promise.all([
                    Promise.resolve().then(() => feed({ type: 'vods', limit: LIMIT, sort: 'top', window: 'week' })).catch(() => null),
                    Promise.resolve().then(() => feed({ type: 'clips', limit: LIMIT, sort: 'top', window: 'week' })).catch(() => null),
                ]);
                if (!vods && !clips) throw new Error('the content feed did not answer');
                const items = [...((vods && vods.items) || []), ...((clips && clips.items) || [])];
                cached = cardFrom(items, at);
                cachedAt = at;
            } catch (err) {
                if (!cached) throw err;
            }
            return cached;
        })().finally(() => { pending = null; });
        return pending;
    }

    return async function menuCard(req, res) {
        try {
            const body = await card();
            res.set('Cache-Control', 'public, max-age=60')
                .set('Access-Control-Allow-Origin', '*')
                .set('Cross-Origin-Resource-Policy', 'cross-origin')
                .json([body]);
        } catch {
            res.status(503).set('Cache-Control', 'no-store').set('Access-Control-Allow-Origin', '*')
                .json({ error: 'menu_unavailable' });
        }
    };
}

module.exports = { createMenuCardHandler, cardFrom, plain, SITE, CARD_ID, CARD_TTL_S };
