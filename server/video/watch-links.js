'use strict';

/**
 * Where a video is watched on openvibe.video: /watch?v=<watch id> (and &t=<seconds> for a start time), YouTube's
 * shape. One address for the three kinds of video — a stream recording, a clip and an upload — so a page is never
 * addressed by a number anyone could count up.
 *
 * A VOD or a clip carries its watch id from OpenVibe.Media (OpenVibe.Media#340); an upload carries its own
 * (server/video/watch-ids.js, migration 0024). A row written before either backfill ran has none yet: then the old
 * path is still what the page answers on, rather than a link to a page that would have to guess.
 */
const { WATCH_ID_RE } = require('./watch-ids');

/** The item's watch id, when it has one. */
const watchIdOf = (item) => (item && WATCH_ID_RE.test(String(item.watch_id || '')) ? String(item.watch_id) : null);

/** The seconds a ?t= names, or null. */
function startSeconds(v) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : null;
}

/** /watch?v=<id>&t=<seconds> */
function watchPath(watchId, { t = null } = {}) {
    const q = new URLSearchParams({ v: String(watchId) });
    const sec = startSeconds(t);
    if (sec) q.set('t', String(sec));
    return `/watch?${q.toString()}`;
}

/** An old address, with the start time an item had no watch id for. */
function legacy(path, opts) {
    const sec = startSeconds(opts && opts.t);
    return sec ? `${path}?t=${sec}` : path;
}

/** The path a recording is watched at: its watch page, or /v/<id> before it has an id. */
const vodPath = (vod, opts) => (watchIdOf(vod) ? watchPath(watchIdOf(vod), opts) : legacy(`/v/${Number(vod.id)}`, opts));

/** The path a clip is watched at. */
const clipPath = (clip, opts) => (watchIdOf(clip) ? watchPath(watchIdOf(clip), opts) : legacy(`/c/${Number(clip.id)}`, opts));

/** The path an upload is watched at: its watch page, or /u/<id> before it has an id. */
const uploadPath = (row, opts) => (watchIdOf(row) ? watchPath(watchIdOf(row), opts) : legacy(`/u/${row.id}`, opts));

/**
 * The query an old address carries over to the watch page: ?t= (a start time) and ?list= (the playlist it plays in).
 * `made`, `saved` and `reported` are notices of the old page and stay behind.
 */
function carriedQuery(query) {
    const q = new URLSearchParams();
    const t = startSeconds(query && query.t);
    if (t) q.set('t', String(t));
    if (query && query.list) q.set('list', String(query.list));
    return q.toString();
}

/** The watch page for an item, carrying the old page's ?t= and ?list=. */
function movedTo(path, query) {
    const q = carriedQuery(query);
    return q ? `${path}${path.includes('?') ? '&' : '?'}${q}` : path;
}

module.exports = { watchIdOf, watchPath, vodPath, clipPath, uploadPath, carriedQuery, movedTo, startSeconds };
