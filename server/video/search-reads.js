'use strict';

/**
 * OpenVibe.Video's read-only view of OpenVibe.Live's recordings in OpenVibe.Search: the categories and channels with
 * their counts (Search's facets), and the recordings of one category, newest first. Live writes one Search document per
 * public recording (owner live, type vod, facets category and channel), so these are the same public recordings the
 * watch pages show; Search only returns public, published, indexable documents.
 *
 * Signed out, no credentials, JSON only. Answers are cached five minutes (at most 200), and anything wrong (no Search
 * URL configured, a timeout, a non-2xx, a body that is not JSON) is null: the home hides the sections and a category
 * page says it cannot list right now. It never throws to the pages.
 */
const TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX = 200;
const PAGE = 24;

// Live's stream categories (OpenVibe.Live server/ai/ai-analysis.js CATEGORIES), as people read them, with an icon each.
const CATEGORIES = {
    gaming: { label: 'Gaming', icon: 'fa-gamepad', blurb: 'Games played live, from battle royales to sports games.' },
    irl: { label: 'IRL and chatting', icon: 'fa-comments', blurb: 'Talking, cooking and everyday life, on camera.' },
    desktop: { label: 'Desktop and tech', icon: 'fa-desktop', blurb: 'Screens shared live: coding, building software and tech.' },
    robot: { label: 'Robots', icon: 'fa-robot', blurb: 'Robots driven, built and tested live.' },
    outdoors: { label: 'Outdoors', icon: 'fa-mountain-sun', blurb: 'Streams from outside: walks, hikes and time in the open air.' },
    travel: { label: 'Travel and driving', icon: 'fa-route', blurb: 'On the road, in the air and out exploring.' },
    building: { label: 'Making and crafts', icon: 'fa-hammer', blurb: 'Building, fixing and making things by hand.' },
    music: { label: 'Music', icon: 'fa-music', blurb: 'Playing, mixing and making music live.' },
    other: { label: 'Everything else', icon: 'fa-shapes', blurb: 'Streams that fit no other shelf.' },
};
const isCategory = (v) => Object.prototype.hasOwnProperty.call(CATEGORIES, String(v || ''));
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

function createSearchReads({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String((config.search && config.search.url) || '').replace(/\/+$/, '');
    const cache = new Map();   // url → { at, value }

    async function getJson(qs) {
        if (!base) return null;
        const url = `${base}/api/v1/search?${qs.toString()}`;
        const entry = cache.get(url);
        if (entry && Date.now() - entry.at < CACHE_TTL_MS) return entry.value;
        try {
            const res = await fetchImpl(url, {
                method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            cache.delete(url);
            cache.set(url, { at: Date.now(), value: body });
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
            return body;
        } catch (err) {
            log.warn('[OpenVibe.Video] Search did not answer', err && err.message ? err.message.slice(0, 120) : err);
            // The last answer, however old, beats an empty shelf.
            return entry ? entry.value : null;
        }
    }

    const facetList = (list) => (Array.isArray(list) ? list : [])
        .map((x) => ({ value: String((x && x.value) || ''), count: Number(x && x.count) || 0 }))
        .filter((x) => x.value && x.count > 0);

    return {
        enabled: Boolean(base),
        /** { categories: [{ slug, label, icon, blurb, count }], channels: [{ username, count }] } or null. */
        async shelves() {
            const body = await getJson(new URLSearchParams({ q: '', owner: 'live', type: 'vod', facets: 'category,channel', limit: '1' }));
            if (!body || !body.facets) return null;
            const categories = facetList(body.facets.category).filter((x) => isCategory(x.value))
                .map((x) => ({ slug: x.value, ...CATEGORIES[x.value], count: x.count }));
            const channels = facetList(body.facets.channel).filter((x) => USERNAME_RE.test(x.value))
                .map((x) => ({ username: x.value, count: x.count }));
            return { categories, channels };
        },
        /** One page of a category's recordings: { items: [{ id, title, channel, duration_seconds, published_at }], next } or null. */
        async category(slug, cursor = null) {
            if (!isCategory(slug)) return null;
            const qs = new URLSearchParams({ q: '', owner: 'live', type: 'vod', 'facet.category': slug, limit: String(PAGE) });
            if (cursor && /^[A-Za-z0-9_-]{1,512}$/.test(String(cursor))) qs.set('cursor', String(cursor));
            const body = await getJson(qs);
            if (!body || !Array.isArray(body.results)) return null;
            const items = body.results
                .filter((x) => x && x.type === 'vod' && /^[1-9]\d{0,15}$/.test(String(x.id)))
                .map((x) => ({
                    id: Number(x.id),
                    title: String(x.title || '').slice(0, 300),
                    channel: x.facets && USERNAME_RE.test(String(x.facets.channel || '')) ? String(x.facets.channel) : null,
                    duration_seconds: x.facets && Number.isFinite(Number(x.facets.duration_seconds)) ? Number(x.facets.duration_seconds) : null,
                    published_at: x.published_at || null,
                }));
            const next = typeof body.next_cursor === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(body.next_cursor) ? body.next_cursor : null;
            return { items, next };
        },
    };
}

module.exports = { createSearchReads, CATEGORIES, isCategory };
