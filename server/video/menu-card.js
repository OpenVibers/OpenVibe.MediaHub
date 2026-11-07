'use strict';

/**
 * The menu's network card for OpenVibe.Video (frame.menu-card@1): GET /.well-known/openvibe-menu.json.
 *
 * Video publishes "Trending": the most viewed public recordings and clips of the last seven days, each linking
 * to its openvibe.video watch page. The rows come from Live's public Content feed (GET /api/content/feed with
 * sort=top&window=week), which merges Media's public VODs and clips and already drops private, unlisted and
 * banned-account items; this module only picks the top six, merges the two lists and builds the card. An entry
 * carries the item's own thumbnail (https on openvibe.media, asked for at 640 px and declared 640×360) when the
 * feed has one; no picture is ever a placeholder.
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

// A card's picture: the 16:9 shape the menu draws, at the 640 px step of Media's thumbnail ladder.
const THUMB_W = 640;
const THUMB_H = 360;
const MEDIA_THUMB = /^https:\/\/openvibe\.media\/t\/[^?#\s]+$/;

/**
 * The entry's own picture ({ src, w?, h? }) or null. Only a real https thumbnail on an openvibe.* host (or this
 * site's own origin) is sent: the feed's null or a third-party picture is left out, never a placeholder. Media's
 * /t/ thumbnails come in sizes, so a card asks for the 640 px WebP it draws and says it is 640×360.
 */
function imageOf(item) {
    const raw = String((item && item.thumbnail_url) || '').trim();
    if (!raw || raw.length > 400) return null;
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'openvibe.video' && !host.startsWith('openvibe.')) return null;
    if (MEDIA_THUMB.test(raw)) return { src: `${raw}?w=${THUMB_W}&fmt=webp`, w: THUMB_W, h: THUMB_H };
    return { src: raw };
}

/** The card itself, most viewed first. `items` are feed items ({ kind, id, title, views, thumbnail_url? }). */
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
            const item = {
                title: plain(it.title || (it.kind === 'clip' ? 'Clip' : 'Stream recording'), 80),
                meta: `${n.toLocaleString('en-US')} ${n === 1 ? 'view' : 'views'} this week`,
                url: `${BASE}${it.watch_id ? `/watch?v=${it.watch_id}` : `/${it.kind === 'clip' ? 'c' : 'v'}/${Number(it.id)}`}`,
            };
            const image = imageOf(it);
            if (image) item.image = image;
            return item;
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

module.exports = { createMenuCardHandler, cardFrom, imageOf, plain, SITE, CARD_ID, CARD_TTL_S };
