'use strict';

/**
 * Uploads on openvibe.video: a signed-in person uploads a video; it becomes an OpenVibe.Media VOD in MediaHub's tenant,
 * so it gets what a Live recording gets (probe, thumbnail, seekable file, HLS timeline), and a watch page at /u/<id>.
 *
 *   start(who, { title, description, visibility, size, contentType })   → the row, and Media's VOD created for it
 *   part(row, n, buffer)       the n-th part, in order (Media appends it to one continuous file)
 *   complete(row)              closes the file; Media finalizes in the background, the row goes processing → ready
 *   refresh(row)               reads Media again for a row still processing (after a restart it is how it finishes)
 *   update(row, patch) / remove(row) / report(row, …)
 *   startRecording(who, { title, description, visibility, contentType })   a video recorded in the browser (/record):
 *                              its size is not known ahead, so parts_expected stays 0 until complete()
 *   chunk(row, n, buffer)      the n-th piece of a recording (any size up to 9 MB), in order; the size and the person's
 *                              quota are checked as it grows
 *   importRecording(vod)       a recording OpenRestream made for a record-only stream, filed as its owner's private video
 *                              when Media says it is ready (media.vod.ready; plan 2026-10-22 §3 D1)
 *
 * Rules: MP4 (QuickTime and M4V are the same container and go to Media as MP4), WebM and Matroska; at most
 * VIDEO_UPLOAD_MAX_BYTES (2 GB) a file, VIDEO_UPLOAD_QUOTA_BYTES (20 GB) a person, VIDEO_UPLOADS_PER_DAY (10) a day.
 * Reports: a child-safety report hides the video at once, three reports from different people hide it; the owner and
 * staff still see a hidden video, labelled. A removed upload's VOD is deleted in Media.
 */
const crypto = require('crypto');

const KINDS = { 'video/mp4': 'video/mp4', 'video/quicktime': 'video/mp4', 'video/x-m4v': 'video/mp4', 'video/webm': 'video/webm', 'video/x-matroska': 'video/x-matroska' };
const EXT_KINDS = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska' };
const VISIBILITY = ['public', 'unlisted', 'private'];
const REASONS = ['child_safety', 'violence', 'harassment', 'sexual', 'copyright', 'spam', 'other'];
const PART_SIZE = 8 * 1024 * 1024;
const HIDE_AFTER = 3;

const cleanLine = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanText = (v, max) => String(v == null ? '' : v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);

class UploadError extends Error {
    constructor(status, code, detail) { super(detail); this.status = status; this.code = code; this.detail = detail; }
}

/** The type the parts are sent to Media as, from the browser's type or else the file name; null when not a video we take. */
function kindOf(contentType, name) {
    const t = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (KINDS[t]) return KINDS[t];
    const ext = String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
    return ext && EXT_KINDS[ext[1]] ? EXT_KINDS[ext[1]] : null;
}

function createUploads({ s, media, config, log = console, events = null }) {
    const cfg = config.videoUploads;
    const addressKey = crypto.createHash('sha256').update(`video-address:${config.oauth.clientSecret || 'dev'}`).digest();
    const addressId = (ip) => `ip:${crypto.createHmac('sha256', addressKey).update(String(ip || 'unknown')).digest('hex').slice(0, 32)}`;
    const running = new Map();   // upload id → the completion in flight in this process

    const byId = (id) => (/^vup_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id)) ? s.db.maybe('SELECT * FROM video_uploads WHERE id = $1', [String(id)]) : null);
    /** An upload by its playlist number (seq, migration 0010). */
    const bySeq = (seq) => (/^[1-9]\d{0,15}$/.test(String(seq)) ? s.db.maybe('SELECT * FROM video_uploads WHERE seq = $1', [Number(seq)]) : null);
    const patchRow = async (id, patch) => {
        const cols = Object.keys(patch);
        await s.db.query(`UPDATE video_uploads SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = $2 WHERE id = $1`, [id, s.iso(), ...cols.map((c) => patch[c])]);
        return await byId(id);
    };

    /**
     * The first time an upload is public, ready and active, published_at is set and mediahub.video.published written in
     * the same transaction (once: private and public again does not repeat it).
     */
    async function maybePublished(row) {
        if (!events || !row || row.published_at || row.status !== 'ready' || row.state !== 'active' || row.visibility !== 'public') return row;
        const at = s.iso();
        return await s.tx(async () => {
            const r = await s.db.maybe('UPDATE video_uploads SET published_at = $2 WHERE id = $1 AND published_at IS NULL RETURNING *', [row.id, at]);
            if (r) await events.videoPublished(r, at);
            return r || row;
        });
    }

    /** May `who` ({ requester, staff }) see this upload at all? */
    function canSee(row, who) {
        if (!row || row.state === 'removed') return false;
        const own = Boolean(who && who.requester && row.owner === who.requester);
        if (own || (who && who.staff)) return true;
        return row.state === 'active' && row.status === 'ready' && row.visibility !== 'private';
    }

    async function start(who, input) {
        if (!who || !who.requester) throw new UploadError(401, 'auth.required', 'Sign in to upload a video.');
        const title = cleanLine(input.title, 120);
        if (!title) throw new UploadError(422, 'upload.title_required', 'Give the video a title.');
        const description = cleanText(input.description, 5000);
        const visibility = VISIBILITY.includes(input.visibility) ? input.visibility : 'public';
        const size = Number(input.size);
        const kind = kindOf(input.contentType, input.name);
        if (!kind) throw new UploadError(415, 'upload.type', 'Upload an MP4, MOV, WebM or MKV video.');
        if (!Number.isInteger(size) || size < 1) throw new UploadError(422, 'upload.size', 'The file is empty.');
        if (size > cfg.maxBytes) throw new UploadError(413, 'upload.too_big', `A video can be at most ${Math.round(cfg.maxBytes / 1024 ** 3)} GB.`);
        const today = s.iso().slice(0, 10);
        const usage = await s.db.maybe(`SELECT count(*) FILTER (WHERE created_at >= $2)::int AS today, coalesce(sum(size_bytes) FILTER (WHERE state <> 'removed'), 0)::bigint AS bytes
                                          FROM video_uploads WHERE owner = $1`, [who.requester, today]);
        if (usage && usage.today >= cfg.perDay) throw new UploadError(429, 'upload.daily_limit', `That is ${cfg.perDay} uploads today. Try again tomorrow.`);
        if (usage && Number(usage.bytes) + size > cfg.quotaBytes) throw new UploadError(413, 'upload.quota', `Your videos would pass ${Math.round(cfg.quotaBytes / 1024 ** 3)} GB. Delete one first.`);
        const vod = await media.vodCreate({ title, visibility, ownerSubject: who.requester });
        if (!vod.ok || !vod.data || vod.data.id == null) throw new UploadError(502, 'upload.media', `OpenVibe.Media could not start the upload (${vod.code || vod.status}).`);
        const id = s.newId('vup');
        const now = s.iso();
        await s.db.query(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, created_at, updated_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
        [id, who.requester, who.username || null, title, description, visibility, Number(vod.data.id), kind, size, PART_SIZE, Math.ceil(size / PART_SIZE), now]);
        return await byId(id);
    }

    async function startRecording(who, input) {
        if (!who || !who.requester) throw new UploadError(401, 'auth.required', 'Sign in to record a video.');
        const title = cleanLine(input.title, 120) || `Recording, ${s.iso().slice(0, 16).replace('T', ' ')} UTC`;
        const description = cleanText(input.description, 5000);
        const visibility = VISIBILITY.includes(input.visibility) ? input.visibility : 'private';
        const t = String(input.contentType || '').split(';')[0].trim().toLowerCase();
        const kind = t === 'video/webm' || t === 'video/mp4' ? t : null;
        if (!kind) throw new UploadError(415, 'upload.type', 'This browser records in a format OpenVibe.Video does not take (WebM or MP4).');
        const today = s.iso().slice(0, 10);
        const usage = await s.db.maybe(`SELECT count(*) FILTER (WHERE created_at >= $2)::int AS today, coalesce(sum(size_bytes) FILTER (WHERE state <> 'removed'), 0)::bigint AS bytes
                                          FROM video_uploads WHERE owner = $1`, [who.requester, today]);
        if (usage && usage.today >= cfg.perDay) throw new UploadError(429, 'upload.daily_limit', `That is ${cfg.perDay} uploads today. Try again tomorrow.`);
        if (usage && Number(usage.bytes) >= cfg.quotaBytes) throw new UploadError(413, 'upload.quota', `Your videos already fill ${Math.round(cfg.quotaBytes / 1024 ** 3)} GB. Delete one first.`);
        const vod = await media.vodCreate({ title, visibility, ownerSubject: who.requester });
        if (!vod.ok || !vod.data || vod.data.id == null) throw new UploadError(502, 'upload.media', `OpenVibe.Media could not start the recording (${vod.code || vod.status}).`);
        const id = s.newId('vup');
        const now = s.iso();
        await s.db.query(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, created_at, updated_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, $9, $9)`,
        [id, who.requester, who.username || null, title, description, visibility, Number(vod.data.id), kind, now]);
        return await byId(id);
    }

    /** A recording's next piece. The total may not pass the per-video limit or the person's quota. */
    async function chunk(row, n, buffer) {
        if (row.status !== 'uploading' || row.parts_expected !== 0) throw new UploadError(409, 'upload.closed', 'This recording is already finished.');
        if (n !== row.parts_received + 1) throw new UploadError(409, 'upload.out_of_order', `Send piece ${row.parts_received + 1} next.`);
        if (!buffer || !buffer.length) throw new UploadError(422, 'upload.empty', 'An empty piece.');
        const size = Number(row.size_bytes) + buffer.length;
        if (size > cfg.maxBytes) throw new UploadError(413, 'upload.too_big', `A video can be at most ${Math.round(cfg.maxBytes / 1024 ** 3)} GB. Stop the recording.`);
        const used = Number(await s.db.value("SELECT coalesce(sum(size_bytes), 0)::bigint FROM video_uploads WHERE owner = $1 AND state <> 'removed' AND id <> $2", [row.owner, row.id]));
        if (used + size > cfg.quotaBytes) throw new UploadError(413, 'upload.quota', `Your videos would pass ${Math.round(cfg.quotaBytes / 1024 ** 3)} GB. Stop the recording.`);
        const out = await media.vodChunk(row.media_vod_id, buffer, row.content_type);
        if (!out.ok) throw new UploadError(502, 'upload.media', `OpenVibe.Media did not take piece ${n} (${out.code || out.status}). Try again.`);
        return await patchRow(row.id, { parts_received: n, size_bytes: size });
    }

    async function part(row, n, buffer) {
        if (row.parts_expected === 0) throw new UploadError(409, 'upload.recording', 'This is a recording: send its pieces to …/chunks/:n.');
        if (row.status !== 'uploading') throw new UploadError(409, 'upload.closed', 'This upload is already finished.');
        if (n !== row.parts_received + 1) throw new UploadError(409, 'upload.out_of_order', `Send part ${row.parts_received + 1} next.`);
        const last = n === row.parts_expected;
        const want = last ? row.size_bytes - (n - 1) * row.part_size : row.part_size;
        if (!buffer || buffer.length !== want) throw new UploadError(422, 'upload.part_size', `Part ${n} should be ${want} bytes.`);
        const out = await media.vodChunk(row.media_vod_id, buffer, row.content_type);
        if (!out.ok) throw new UploadError(502, 'upload.media', `OpenVibe.Media did not take part ${n} (${out.code || out.status}). Try again.`);
        return await patchRow(row.id, { parts_received: n });
    }

    /** What Media says about the VOD → the row's status, duration and thumbnail. */
    async function absorb(row, vod) {
        const v = vod && (vod.vod || vod);
        if (!v || v.is_recording) return row;
        const duration = Number(v.duration_seconds);
        const ready = Boolean(v.file_url || v.playback_url) && Number.isFinite(duration) && duration > 0;
        if (!ready) return row;
        return await maybePublished(await patchRow(row.id, { status: 'ready', duration_seconds: duration, thumbnail_url: v.thumbnail_url || null, ready_at: row.ready_at || s.iso(), error: null }));
    }

    async function complete(row) {
        if (row.status === 'ready' || row.status === 'processing') return row;
        const recording = row.parts_expected === 0;
        if (recording && row.parts_received < 1) throw new UploadError(409, 'upload.incomplete', 'Nothing was recorded.');
        if (!recording && row.parts_received !== row.parts_expected) throw new UploadError(409, 'upload.incomplete', `${row.parts_expected - row.parts_received} parts are still missing.`);
        const now = await patchRow(row.id, { status: 'processing', ...(recording ? { parts_expected: row.parts_received } : {}) });
        // Media can take minutes on a big file: answer now, finish in the background (refresh() finishes it after a restart).
        const job = media.vodComplete(row.media_vod_id).then(async (out) => {
            if (out.ok) return await absorb(await byId(row.id), out.data);
            if (out.status >= 500 || out.code === 'media.unreachable') return null;   // refresh() asks again later
            return await patchRow(row.id, { status: 'failed', error: `Media could not process the video (${out.code || out.status}).` });
        }).catch((err) => { log.warn('[MediaHub] video completion:', err.message); return null; })
            .finally(() => running.delete(row.id));
        running.set(row.id, job);
        return now;
    }

    /**
     * A recording OpenRestream made for a record-only stream ("Record only, to my videos" on openre.stream): Media's VOD
     * in this tenant, ready, becomes its owner's private video here, like a browser recording, with the AI edit on its
     * page. Only a VOD of this tenant whose meta says so is taken (source openre, record_only, the owner's subject):
     * MediaHub and OpenRestream are the only services that may write to this tenant. A VOD already filed changes
     * nothing (one upload per VOD, migration 0018). It counts toward the person's storage like any video, but is never
     * refused for it: the session was already recorded. → the row, or null when the VOD is not such a recording.
     */
    async function importRecording(event) {
        if (!event || String(event.app_id) !== String(config.media.app)) return null;
        const vodId = Number(event.id);
        if (!Number.isSafeInteger(vodId) || vodId < 1) return null;
        // Media leaves a VOD's meta out of its events (they reach every subscriber, server/events.js slim): it is read
        // back from Media here, with this tenant's own access, for a VOD of this tenant only. Media unreachable throws,
        // so Events delivers the event again; a VOD Media no longer has is nothing to file.
        let vod = event;
        if (!event.meta) {
            const out = await media.vodGet(vodId);
            if (!out.ok) {
                if (out.status === 404 || out.status === 410) return null;
                throw new Error(`OpenVibe.Media could not be read for VOD ${vodId} (${out.code || out.status})`);
            }
            vod = { ...event, ...(out.data && (out.data.vod || out.data)) };
        }
        const meta = vod.meta && typeof vod.meta === 'object' ? vod.meta : {};
        if (meta.source !== 'openre' || meta.record_only !== true) return null;
        const subject = String(meta.owner_subject || '');
        if (!/^usr_[0-9A-HJKMNP-TV-Z]{26}$/.test(subject)) return null;
        const known = await s.db.maybe('SELECT * FROM video_uploads WHERE media_vod_id = $1', [vodId]);
        if (known) return known;
        const now = s.iso();
        const title = cleanLine(vod.title, 120) || `Recording, ${now.slice(0, 16).replace('T', ' ')} UTC`;
        const size = Number(vod.file_size) > 0 ? Math.round(Number(vod.file_size)) : 0;
        const row = await s.db.maybe(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, status, created_at, updated_at)
                                       VALUES ($1, $2, NULL, $3, '', 'private', $4, 'video/mp4', $5, 0, 0, 'processing', $6, $6)
                                       ON CONFLICT (media_vod_id) WHERE media_vod_id IS NOT NULL DO NOTHING RETURNING *`,
        [s.newId('vup'), `user:${subject}`, title, vodId, size, now]);
        if (!row) return await s.db.maybe('SELECT * FROM video_uploads WHERE media_vod_id = $1', [vodId]);
        log.log(`[MediaHub] a record-only recording is ${row.id} (Media VOD ${vodId})`);
        return await absorb(row, vod);
    }

    /** The owner's channel name on rows filed without one (record-only recordings), once they are signed in to see them. */
    async function fillUsername(owner, username) {
        if (!owner || !username) return 0;
        return await s.db.exec('UPDATE video_uploads SET owner_username = $2 WHERE owner = $1 AND owner_username IS NULL', [owner, String(username).slice(0, 64)]);
    }

    /** A row still processing: ask Media how it is going (no more than once every 15 seconds per row). */
    const lastAsked = new Map();
    async function refresh(row) {
        if (!row || row.status !== 'processing' || running.has(row.id)) return row;
        const t = Date.now();
        if (t - (lastAsked.get(row.id) || 0) < 15_000) return row;
        lastAsked.set(row.id, t);
        const out = await media.vodGet(row.media_vod_id);
        if (out.ok) return await absorb(row, out.data);
        if (out.status === 404) return await patchRow(row.id, { status: 'failed', error: 'Media no longer has this video.' });
        return row;
    }

    async function update(row, input) {
        const patch = {};
        if (input.title !== undefined) { const t = cleanLine(input.title, 120); if (!t) throw new UploadError(422, 'upload.title_required', 'Give the video a title.'); patch.title = t; }
        if (input.description !== undefined) patch.description = cleanText(input.description, 5000);
        if (input.visibility !== undefined) { if (!VISIBILITY.includes(input.visibility)) throw new UploadError(422, 'upload.visibility', 'Public, unlisted or private.'); patch.visibility = input.visibility; }
        if (!Object.keys(patch).length) return row;
        if (patch.title || patch.visibility) await media.vodUpdate(row.media_vod_id, { ...(patch.title ? { title: patch.title } : {}), ...(patch.visibility ? { visibility: patch.visibility } : {}) });
        return await maybePublished(await patchRow(row.id, patch));
    }

    async function remove(row) {
        const out = await media.vodDelete(row.media_vod_id);
        if (!out.ok && out.status !== 404) log.warn(`[MediaHub] video ${row.id}: Media refused the delete: ${out.status} ${out.code}`);
        return await patchRow(row.id, { state: 'removed' });
    }

    async function report(row, { reporter, reason, note }) {
        if (!REASONS.includes(reason)) throw new UploadError(422, 'report.reason', 'Choose what is wrong with the video.');
        const added = Boolean(await s.db.maybe(`INSERT INTO video_upload_reports (upload_id, reporter, reason, note, created_at) VALUES ($1, $2, $3, $4, $5)
                                                 ON CONFLICT (upload_id, reporter) DO NOTHING RETURNING upload_id`, [row.id, reporter, reason, cleanText(note, 1000), s.iso()]));
        if (!added) return { recorded: false, hidden: row.state === 'hidden' };
        const n = Number(await s.db.value('SELECT count(*) FROM video_upload_reports WHERE upload_id = $1', [row.id]));
        const hide = row.state === 'active' && (reason === 'child_safety' || n >= HIDE_AFTER);
        await patchRow(row.id, { report_count: n, ...(hide ? { state: 'hidden' } : {}) });
        return { recorded: true, hidden: hide || row.state === 'hidden' };
    }

    return {
        PART_SIZE, REASONS, UploadError, kindOf, addressId, canSee,
        byId, bySeq, start, part, complete, refresh, update, remove, report, startRecording, chunk, importRecording, fillUsername,
        mine: (owner, limit = 60) => s.db.many("SELECT * FROM video_uploads WHERE owner = $1 AND state <> 'removed' ORDER BY id DESC LIMIT $2", [owner, limit]),
        latest: (limit = 12) => s.db.many("SELECT * FROM video_uploads WHERE visibility = 'public' AND status = 'ready' AND state = 'active' ORDER BY id DESC LIMIT $1", [limit]),
        channel: (username, limit = 48) => s.db.many("SELECT * FROM video_uploads WHERE lower(owner_username) = lower($1) AND visibility = 'public' AND status = 'ready' AND state = 'active' ORDER BY id DESC LIMIT $2", [String(username), limit]),
        view: async (row) => { await s.db.query('UPDATE video_uploads SET views = views + 1 WHERE id = $1', [row.id]); },
        playback: async (row) => { const out = await media.vodGet(row.media_vod_id); return out.ok ? (out.data.vod || out.data) : null; },
    };
}

module.exports = { createUploads, kindOf, UploadError, KINDS, REASONS, VISIBILITY };
