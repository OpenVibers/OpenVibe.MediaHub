'use strict';

/**
 * OpenVibe.Video's read-only client for OpenVibe.Chat's public chat replay. Like live-client.js it
 * is signed out, never sends cookies or credentials, only accepts JSON, and caches answers in memory
 * for a minute. Unlike live-client it never throws to the pages: Chat is optional, so anything wrong
 * — a timeout, a non-2xx, a body that is not JSON, an invalid stream id — becomes null (no chat panel)
 * and the page still renders.
 */
const { isId } = require('./live-client');

const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;

function createChatClient({ config, fetchImpl = globalThis.fetch, log = console } = {}) {
    const cache = new Map();   // url → { at, value }
    const base = String(config.video.chatUrl).replace(/\/+$/, '');

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

    /** The chat history for a stream, or null when it cannot be read (never throws). */
    async function chatReplay(streamId) {
        if (!isId(streamId)) return null;

        const url = `${base}/api/chat/${streamId}/replay`;
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
            log.warn('[OpenVibe.Video] Chat did not answer', err && err.name);
            return null;
        }

        if (!res.ok) return null;

        try {
            return remember(url, await res.json());
        } catch {
            return null;
        }
    }

    return { chatReplay };
}

module.exports = { createChatClient };
