'use strict';
/**
 * openvibe.video tells search engines about new watch pages (IndexNow, openvibe-shared/indexnow).
 *
 * Live publishes the recordings and clips, and nothing tells this service when one becomes public, so a sweep reads
 * Live's public feed (the newest recordings and clips, signed out) every few minutes. The first read only remembers
 * what is already there; each later read pings the pages it has not seen before: the watch page, its channel page and
 * the sitemap, in one batch. A restart remembers afresh, so a page published while the process was down reaches the
 * engines through the sitemap instead of a ping. A sweep that cannot read both feeds pings nothing and remembers
 * nothing, so a Live outage never primes the memory with half a feed.
 *
 * Off without a key (INDEXNOW_KEY): start() does nothing and sweep() reads nothing.
 */
const { USERNAME_RE } = require('./live-client');

function createVideoIndexNow({ config, live, indexnow, log = console, intervalMs = 10 * 60_000, limit = 50, maxRemembered = 5000 }) {
    const base = config.video.url.replace(/\/$/, '');
    const seen = new Set();
    let primed = false;
    let running = false;
    let timer = null;

    async function sweep() {
        if (!indexnow || !indexnow.enabled || running) return { pinged: 0 };
        running = true;
        try {
            let pages;
            try {
                pages = await Promise.all(['vods', 'clips'].map((type) => live.feed({ type, limit })));
            } catch (err) {
                log.warn(`[Video IndexNow] the feed could not be read: ${(err && err.message) || err}`);
                return { pinged: 0, skipped: 'feed' };
            }
            const urls = [];
            let fresh = 0;
            for (const it of pages.flatMap((p) => (p && Array.isArray(p.items) ? p.items : []))) {
                const id = Number(it && it.id);
                if (!Number.isSafeInteger(id) || id <= 0) continue;
                const path = `${it.kind === 'clip' ? '/c/' : '/v/'}${id}`;
                if (seen.has(path)) continue;
                seen.add(path);
                if (!primed) continue;
                fresh++;
                urls.push(`${base}${path}`);
                const u = it.channel && it.channel.username;
                if (u && USERNAME_RE.test(u)) urls.push(`${base}/@${u}`);
            }
            primed = true;
            while (seen.size > maxRemembered) seen.delete(seen.values().next().value);
            if (urls.length) indexnow.pingSoon([...urls, `${base}/sitemap.xml`]);
            return { pinged: fresh };
        } finally { running = false; }
    }

    function start() {
        if (!indexnow || !indexnow.enabled || timer) return false;
        const tick = () => { sweep().catch((err) => log.warn(`[Video IndexNow] sweep failed: ${(err && err.message) || err}`)); };
        tick();
        timer = setInterval(tick, intervalMs);
        if (timer.unref) timer.unref();
        return true;
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    return { sweep, start, stop };
}

module.exports = { createVideoIndexNow };
