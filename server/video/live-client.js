'use strict';

/**
 * OpenVibe.Video's read-only client for OpenVibe.Live's public JSON API. It is signed out, never
 * sends cookies or credentials, and only accepts JSON. A 404 is a missing/private item (null);
 * anything else wrong — a timeout, a non-2xx, a body that is not JSON — becomes a typed error the
 * pages render as a 502.
 *
 * The answers are cached in memory for a minute (details and lists alike), at most 500 entries,
 * oldest dropped. Ids and usernames are validated before any request so a malformed route can never
 * reach Live.
 */
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const USERNAME_RE = /^[A-Za-z0-9_]{1,32}$/;

/** Positive safe integers (the kind Live uses for VOD and clip ids). */
function isId(v) {
    return /^[1-9]\d*$/.test(String(v)) && Number.isSafeInteger(Number(v)) && Number(v) > 0;
}

/** Live answered an owner call with a 4xx: its status and its own message, shown to the person. */
class LiveRefusedError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'LiveRefusedError';
        this.status = status;
    }
}

/** Live was down or answered nonsense: the pages turn this into a 502. */
class LiveUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LiveUnavailableError';
        this.liveUnavailable = true;
    }
}

function createLiveClient({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const cache = new Map();   // url → { at, value }

    function hit(key) {
        const entry = cache.get(key);
        if (!entry) return undefined;
        if (Date.now() - entry.at < CACHE_TTL_MS) {
            cache.delete(key);
            cache.set(key, entry);   // touch: this entry is now the most recent
            return entry.value;
        }
        cache.delete(key);
        return undefined;
    }

    function remember(key, value) {
        cache.delete(key);
        cache.set(key, { at: Date.now(), value });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return value;
    }

    async function getJson(path) {
        const url = `${config.video.liveUrl}${path}`;
        const cached = hit(url);
        if (cached !== undefined) return cached;

        let res;
        try {
            res = await fetchImpl(url, {
                method: 'GET',
                headers: { Accept: 'application/json' },
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
        } catch (err) {
            log.warn('[OpenVibe.Video] Live did not answer', err && err.name);
            throw new LiveUnavailableError('OpenVibe.Live did not answer; try again in a minute.');
        }

        if (res.status === 404) return null;
        if (!res.ok) throw new LiveUnavailableError('OpenVibe.Live did not answer; try again in a minute.');

        let body;
        try {
            body = await res.json();
        } catch {
            throw new LiveUnavailableError('OpenVibe.Live did not answer; try again in a minute.');
        }
        return remember(url, body);
    }

    /**
     * A call made AS the signed-in person (their Network token as a Bearer; Live checks the issuer and decides what
     * they may do), never cached. 2xx → the JSON body; a 4xx → LiveRefusedError carrying Live's status and message
     * (a 401 lets the caller refresh the session and try once more); anything else → LiveUnavailableError.
     */
    async function asPerson(token, method, path, body, { viewerIp = null } = {}) {
        let res;
        try {
            res = await fetchImpl(`${config.video.liveUrl}${path}`, {
                method,
                headers: {
                    Accept: 'application/json', Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}),
                    // Live limits clip-making per address too; every call from here comes from this server, so the
                    // person's own address is passed (Live reads the first X-Forwarded-For entry).
                    ...(viewerIp ? { 'X-Forwarded-For': viewerIp } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                credentials: 'omit',
                cache: 'no-store',
                signal: AbortSignal.timeout(TIMEOUT_MS * 2),
            });
        } catch (err) {
            log.warn('[OpenVibe.Video] Live did not answer an owner call', err && err.name);
            throw new LiveUnavailableError('OpenVibe.Live did not answer; try again in a minute.');
        }
        const data = await res.json().catch(() => null);
        if (res.ok) return data || {};
        if (res.status >= 400 && res.status < 500) {
            throw new LiveRefusedError(res.status, (data && typeof data.error === 'string' && data.error.slice(0, 200)) || 'OpenVibe.Live refused that.');
        }
        throw new LiveUnavailableError('OpenVibe.Live did not answer; try again in a minute.');
    }

    /** After an owner's change: drop the cached reads of this item and every cached list, so pages show it at once. */
    function forget(kind, id) {
        const one = `${config.video.liveUrl}/api/${kind === 'clip' ? 'clips' : 'vods'}/${id}`;
        for (const key of [...cache.keys()]) {
            if (key === one || key.startsWith(`${one}/`) || key.includes('/api/vods?') || key.includes('/api/clips?') || key.includes('/api/content/feed?')) cache.delete(key);
        }
    }

    /** Only this item's cached read (a clip still being cut is read afresh until it is ready). */
    function forgetItem(kind, id) {
        cache.delete(`${config.video.liveUrl}/api/${kind === 'clip' ? 'clips' : 'vods'}/${id}`);
    }

    return {
        forgetItem,
        /** The person's own view of one item (a private one they own or may moderate included); null when Live says 404. */
        async vodAs(token, id) {
            try { return await asPerson(token, 'GET', `/api/vods/${id}`); } catch (err) { if (err.status === 404) return null; throw err; }
        },
        async clipAs(token, id) {
            try { return await asPerson(token, 'GET', `/api/clips/${id}`); } catch (err) { if (err.status === 404) return null; throw err; }
        },
        updateVod: (token, id, fields) => asPerson(token, 'PUT', `/api/vods/${id}`, fields),
        deleteVod: (token, id) => asPerson(token, 'DELETE', `/api/vods/${id}`),
        setClipTitle: (token, id, title) => asPerson(token, 'PUT', `/api/clips/${id}/title`, { title }),
        setClipVisibility: (token, id, visibility) => asPerson(token, 'PUT', `/api/clips/${id}/visibility`, { visibility }),
        deleteClip: (token, id) => asPerson(token, 'DELETE', `/api/clips/${id}`),
        /** A clip of a recording, cut by Media: { vod_id, start_time, end_time, title } → { clip } (Live's rules and limits). */
        createClip: (token, fields, viewerIp) => asPerson(token, 'POST', '/api/vods/clips', fields, { viewerIp }),
        forget,
        feed({ type, limit, cursor = null }) {
            const qs = new URLSearchParams({ type, limit: String(limit) });
            // Live's feed pages by an opaque cursor (its `next`); only a plain token is passed on.
            if (cursor && /^[A-Za-z0-9_-]{1,200}$/.test(String(cursor))) qs.set('cursor', String(cursor));
            return getJson(`/api/content/feed?${qs.toString()}`);
        },
        vodsByUser(username, { limit, offset = 0 }) {
            const qs = new URLSearchParams({ username, limit: String(limit), offset: String(offset) });
            return getJson(`/api/vods?${qs.toString()}`);
        },
        clipsByUser(username, { limit }) {
            const qs = new URLSearchParams({ username, limit: String(limit) });
            return getJson(`/api/clips?${qs.toString()}`);
        },
        vod(id) {
            return getJson(`/api/vods/${id}`);
        },
        vodMemories(id) {
            return getJson(`/api/vods/${id}/memories`);
        },
        clip(id) {
            return getJson(`/api/clips/${id}`);
        },
        comments(kind, id) {
            return getJson(`/api/comments/${kind}/${id}`);
        },
        isId,
        isUsername: (u) => USERNAME_RE.test(String(u || '')),
    };
}

module.exports = { createLiveClient, LiveUnavailableError, LiveRefusedError, isId, USERNAME_RE };
