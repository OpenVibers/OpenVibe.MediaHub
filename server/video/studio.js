'use strict';

/**
 * The OpenVibe.Video side of Studio's "Edit in Studio" hand-off.
 *
 * A person records or uploads a video on openvibe.video, then opens it in Studio at
 * https://openvibe.studio/edit?media=<the video's id>&from=video. Studio is a different
 * origin, so the person's Studio session is not Video's cookie: Studio calls these routes
 * server-to-server with the person's own Network token as a Bearer (the same token its SSO
 * issues), and MediaHub decides what that person may read or change.
 *
 *   GET  /api/v1/video/studio/media/:id         the video (metadata, and where it came from)
 *   GET  /api/v1/video/studio/media/:id/bytes   its bytes, Range reads included (the preview)
 *   POST /api/v1/video/studio/publish           a private copy published back on Video
 *
 * :id is one of the ids the person already has for the video: the upload id (vup_…), the
 * /watch?v= id, or Media's VOD id (media_vod_id). A private video of someone else answers
 * exactly like a missing id, so an id cannot be used to learn that it exists. Reading needs
 * what the watch page needs; PUBLISHING needs the owner. The copies are made by the same
 * upload path as a browser recording, so Media probes them, makes the thumbnail and HLS,
 * and the AI edit gets captions and chapters.
 */
const { Readable } = require('node:stream');
const { UploadError } = require('./uploads');

const PIECE = 8 * 1024 * 1024;
const VUP_RE = /^vup_[0-9A-HJKMNP-TV-Z]{26}$/;
const WATCH_RE = /^[A-Za-z0-9_-]{11}$/;
const VOD_RE = /^[1-9]\d{0,15}$/;

/** `id` as a video_uploads row, or null. The three id spaces the site itself shows. */
function findRow(uploads, id) {
    const s = String(id || '');
    if (VUP_RE.test(s)) return uploads.byId(s);
    if (WATCH_RE.test(s)) return uploads.byWatchId(s);
    if (VOD_RE.test(s)) return uploads.byMediaVod(Number(s));
    return null;
}

function watchPath(row) {
    return row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`;
}

/**
 * The video as Studio is allowed to see it. `source` names where it came from, so Studio can
 * say "From OpenVibe.Video" rather than pretending the video appeared there.
 */
function wire(row, { canEdit = false, baseUrl = 'https://openvibe.video' } = {}) {
    const path = watchPath(row);
    return {
        media: {
            id: row.id,
            media_id: row.media_vod_id == null ? null : Number(row.media_vod_id),
            kind: 'video',
            title: row.title,
            description: row.description || '',
            status: row.status,
            visibility: row.visibility,
            mime_type: row.content_type,
            size_bytes: Number(row.size_bytes) || 0,
            duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
            thumbnail_url: row.thumbnail_url || null,
            watch_url: `${String(baseUrl).replace(/\/+$/, '')}${path}`,
            page_path: path,
            can_edit: canEdit === true,
            edited_from: row.edited_from || null,
        },
        source: {
            id: 'video',
            name: 'OpenVibe.Video',
            url: `${String(baseUrl).replace(/\/+$/, '')}${path}`,
        },
    };
}

function createStudio({ s, media, uploads, config, log = console, fetchImpl = globalThis.fetch }) {
    const mediaBase = String((config.media && config.media.url) || '').replace(/\/+$/, '');
    const videoBase = String((config.video && config.video.url) || 'https://openvibe.video').replace(/\/+$/, '');

    function notFound() {
        // The same answer for "no such video" and "someone else's private video".
        return new UploadError(404, 'studio.media_not_found', 'No such video, or it is not yours to open.');
    }

    /**
     * The row and whether this person may edit it. Reading is the watch page's rule
     * (uploads.canSee): the owner, staff, or a ready active video that is not private.
     */
    async function resolve(id, principal) {
        if (!principal || principal.kind !== 'user' || !principal.requester) return null;
        const row = await findRow(uploads, id);
        const staff = ['admin', 'global_mod'].includes(String(principal.role || ''));
        if (!uploads.canSee(row, { requester: principal.requester, staff })) return null;
        return { row, canEdit: row.owner === principal.requester || staff };
    }

    /** A Media-signed URL for the VOD, moved to the one Media address this service may call. */
    async function sourceUrl(row) {
        const signed = await media.vodSignedUrl(row.media_vod_id, 600);
        if (!signed.ok || !signed.data || !signed.data.url) throw new UploadError(502, 'studio.media_unavailable', 'OpenVibe.Media did not give a readable address for this video.');
        const u = new URL(signed.data.url);
        return mediaBase ? `${mediaBase}${u.pathname}${u.search}` : signed.data.url;
    }

    /** The video's bytes, read from Media, with the Range the caller asked for. */
    async function bytes(row, range) {
        const url = await sourceUrl(row);
        let res;
        try {
            res = await fetchImpl(url, { headers: range ? { range: String(range) } : {}, redirect: 'error', signal: AbortSignal.timeout(2 * 3600_000) });
        } catch (err) {
            log.warn('[MediaHub] Studio could not read a video:', (err && err.message) || '');
            throw new UploadError(502, 'studio.media_unavailable', 'OpenVibe.Media did not answer.');
        }
        if (!res.ok && res.status !== 206) {
            if (res.body) res.body.cancel().catch(() => {});
            throw new UploadError(res.status === 416 ? 416 : 502, 'studio.media_unavailable', 'OpenVibe.Media could not serve this video.');
        }
        return {
            status: res.status,
            headers: {
                'content-type': res.headers.get('content-type') || row.content_type || 'application/octet-stream',
                'accept-ranges': res.headers.get('accept-ranges') || 'bytes',
                ...(res.headers.get('content-range') ? { 'content-range': res.headers.get('content-range') } : {}),
                ...(res.headers.get('content-length') ? { 'content-length': res.headers.get('content-length') } : {}),
            },
            body: res.body,
        };
    }

    /**
     * Publish a private copy of the owner's video back on Video, with the title and visibility
     * Studio asked for. The bytes go from Media to Media through this service, never through the
     * browser; the copy takes the same path as a browser recording, so it is probed and made
     * playable like any other upload. The original is never changed.
     */
    async function publish(row, principal, { title, visibility } = {}) {
        if (!row || row.owner !== principal.requester) throw notFound();
        if (row.status !== 'ready' || row.state !== 'active') throw new UploadError(409, 'studio.media_not_ready', 'The video has to be ready (and not hidden) before it can be published from Studio.');
        const total = Number(row.size_bytes);
        if (!Number.isSafeInteger(total) || total < 1) throw new UploadError(409, 'studio.media_size', 'OpenVibe.Media has not reported this video\'s size yet.');
        const wantedTitle = String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, 120) || `${row.title.slice(0, 100)} (Studio)`;
        const wantedVisibility = ['private', 'unlisted', 'public'].includes(visibility) ? visibility : 'private';
        const source = await sourceUrl(row);
        let res;
        try {
            res = await fetchImpl(source, { redirect: 'error', signal: AbortSignal.timeout(6 * 3600_000) });
        } catch (err) {
            log.warn('[MediaHub] Studio publish could not read the video:', (err && err.message) || '');
            throw new UploadError(502, 'studio.media_unavailable', 'OpenVibe.Media did not answer.');
        }
        if (!res.ok) {
            if (res.body) res.body.cancel().catch(() => {});
            throw new UploadError(502, 'studio.media_unavailable', 'OpenVibe.Media could not serve this video.');
        }
        let copy = null;
        try {
            copy = await uploads.start({ requester: row.owner, username: row.owner_username }, {
                title: wantedTitle, description: row.description || '', visibility: wantedVisibility,
                size: total, contentType: row.content_type, name: row.title,
            });
            let pending = Buffer.alloc(0);
            let n = 0;
            let read = 0;
            for await (const chunk of res.body) {
                const part = Buffer.from(chunk);
                read += part.length;
                pending = pending.length ? Buffer.concat([pending, part]) : part;
                while (pending.length >= PIECE) {
                    await uploads.part(copy, ++n, pending.subarray(0, PIECE));
                    pending = pending.subarray(PIECE);
                }
            }
            if (pending.length) await uploads.part(copy, ++n, pending);
            if (read !== total || n !== Number(copy.parts_expected)) throw new UploadError(502, 'studio.media_size', 'OpenVibe.Media gave a different number of bytes than it reported.');
            const done = await uploads.complete(await uploads.byId(copy.id));
            // The copy names its original, as an AI-cut copy does, so its page says where it came from.
            await s.db.query('UPDATE video_uploads SET edited_from = $2 WHERE id = $1', [copy.id, row.id]);
            const path = watchPath(done);
            return { video: { id: done.id, status: done.status, title: done.title, url: path, watch_url: `${videoBase}${path}` } };
        } catch (err) {
            if (copy) await uploads.remove(copy).catch(() => {});
            throw err;
        }
    }

    return {
        resolve,
        wire: (row, options = {}) => wire(row, { ...options, baseUrl: videoBase }),
        bytes,
        publish,
        notFound,
        findRow: (id) => findRow(uploads, id),
        /** A stream as an Express response can take it (kept here so the route needs no node:stream import). */
        sendBody: (body) => Readable.fromWeb(body),
    };
}

module.exports = { createStudio, findRow, wire, watchPath };
