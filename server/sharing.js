'use strict';

/**
 * Sharing for MediaHub uploads and albums (design 2026-11-06, VISIBILITY-EVERYWHERE step 4;
 * openvibe-sdk/share). The person's choice at upload, Everyone by default.
 *
 * The SDK owns the model and the rules: the `shares` row next to each picture, video, download or
 * album, the one access check (canView), members, requests, transfers, the log and the queue. This
 * file is the wiring a service supplies:
 *
 *   - network.json    Network's identity lookups (@name → subject, a person's card for the sheet)
 *   - events.publish  MediaHub's Events outbox
 *   - notify          Network's notification push; a refusal is logged, never allowed to stall the queue
 *
 * Pictures and albums have no visibility column: the share row is the authority. Their pages were
 * always unlisted and never indexed, so Everyone here means "anyone with the link", exactly as the
 * product already worked; Only me and Specific people are the new, narrower choices.
 */
const { createShares, ShareError } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'mediahub';
const KINDS = ['picture', 'album', 'video', 'download'];
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** MediaHub's thread words to the SDK's (there is no column to keep in step). */
const TO_SDK = { public: 'public', link: 'link', unlisted: 'link', people: 'people', private: 'private' };
const FROM_SDK = { public: 'public', link: 'unlisted', people: 'private', private: 'private' };

const refOf = (kind, id) => ({ service: SERVICE, kind: String(kind), id: String(id) });

/** MediaHub's viewer as the SDK wants it: a subject object, and the staff bit. */
function shareViewer(v) {
    if (!v || !v.subject) return null;
    if (String(v.subject).startsWith('usr_')) return { subject: { type: 'user', id: v.subject }, staff: !!v.staff };
    if (String(v.subject).startsWith('gst_')) return { subject: { type: 'guest', id: v.subject }, staff: !!v.staff };
    return null;
}

/** A `user:usr_…` requester (what the pictures' owner column holds) as a share subject. */
const subjectOf = (requester) => {
    const s = String(requester || '');
    if (s.startsWith('user:usr_')) return { type: 'user', id: s.slice(5) };
    if (s.startsWith('guest:gst_')) return { type: 'guest', id: s.slice(6) };
    return null;
};

function createSharing({ db, config, outbox, media, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
    const base = String(config.networkInternalUrl || config.networkUrl || '').replace(/\/+$/, '');
    const tokens = config.oauth && config.oauth.clientSecret ? serviceAuth.createTokenClient({
        tokenUrl: `${base}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.network', scope: 'identity.subject.resolve network.notifications.push', fetchImpl,
    }) : null;

    async function networkJson({ path, method = 'GET', json, query } = {}) {
        if (!tokens) throw new Error('Network is not configured for this service');
        const url = new URL(`${base}${path}`);
        for (const [k, v] of Object.entries(query || {})) if (v != null) url.searchParams.set(k, String(v));
        const headers = { Accept: 'application/json', ...(await tokens.authHeaders()) };
        if (json !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetchImpl(url, { method, headers, body: json === undefined ? undefined : JSON.stringify(json), signal: AbortSignal.timeout(8000) });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
            const err = new Error(`Network ${method} ${path} ${res.status}: ${(body && (body.detail || body.error)) || 'failed'}`);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    /** One notification, addressed by canonical subject. It never carries an upload's title. */
    async function notify(n) {
        const to = n && n.to;
        if (!to || to.type !== 'user') return;
        const words = {
            'share.added': ['Something was shared with you', 'Open it on OpenVibe.MediaHub.'],
            'share.access_requested': ['Someone asked for access', 'Review the request on OpenVibe.MediaHub.'],
            'share.transfer.requested': ['Someone wants to give you an upload', 'Accept or decline it on OpenVibe.MediaHub.'],
            'share.transfer.answered': ['An upload transfer was answered', 'See what happened on OpenVibe.MediaHub.'],
        }[n.kind] || ['Sharing on OpenVibe.MediaHub', 'There is something new for you.'];
        try {
            await networkJson({ path: '/internal/notifications/push', method: 'POST', json: {
                subject: to.id, type: 'GENERIC', title: words[0], message: words[1],
                service: 'mediahub', url: config.baseUrl, category: 'social',
            } });
        } catch (err) { log.warn('[Sharing] notification not sent:', err.message); }
    }

    let changedHook = null;
    const shares = createShares({
        db, network: { json: networkJson }, events: { publish: async (envelope) => await outbox.emit(envelope) }, notify,
        // The audience word goes into the item's own column, the 1:1 mapping, so every gathered page that filters on
        // it (the gallery, albums, the album page, the sitemap) stops listing an item the owner narrowed. An album's
        // pictures follow the album (design 2026-11-06). Video's column is its old visibility word.
        onAudienceChange: async (ref, audience, tx) => {
            if (ref.kind === 'picture' || ref.kind === 'album') {
                const table = ref.kind === 'picture' ? 'pics_images' : 'pics_albums';
                await tx.exec(`UPDATE ${table} SET audience = $1 WHERE id = $2`, [audience, ref.id]);
                if (ref.kind === 'picture' && audience !== 'public') await tx.exec('UPDATE pics_images SET listed = false WHERE id = $1', [ref.id]);
                if (ref.kind === 'album') {
                    if (audience !== 'public') await tx.exec('UPDATE pics_images SET listed = false WHERE id IN (SELECT image_id FROM pics_album_images WHERE album_id = $1)', [ref.id]);
                    await tx.exec('UPDATE pics_images SET audience = $1 WHERE id IN (SELECT image_id FROM pics_album_images WHERE album_id = $2)', [audience, ref.id]);
                    await tx.exec("UPDATE shares SET audience = $1, revision = revision + 1 WHERE service = $2 AND kind = 'picture' AND resource_id IN (SELECT image_id FROM pics_album_images WHERE album_id = $3)", [audience, SERVICE, ref.id]);
                }
            } else if (ref.kind === 'video') {
                const vis = audience === 'public' ? 'public' : audience === 'link' ? 'unlisted' : 'private';
                const row = await tx.maybe('SELECT media_vod_id FROM video_uploads WHERE id = $1', [ref.id]);
                if (row && media) {
                    const result = await media.vodUpdate(row.media_vod_id, { visibility: vis });
                    if (result && result.ok === false) throw new ShareError(502, 'share.media_unavailable', 'Video storage could not change the visibility');
                }
                await tx.exec('UPDATE video_uploads SET visibility = $1 WHERE id = $2', [vis, ref.id]);
            } else if (ref.kind === 'download') {
                await tx.exec('UPDATE mh_files SET share_v1 = true WHERE id = $1', [ref.id]);
                if (audience === 'people' || audience === 'private') {
                    // An expiring legacy file or folder link must not bypass a narrower Share choice.
                    await tx.exec(`UPDATE mh_shares SET revoked_at = coalesce(revoked_at, now()::text)
                        WHERE (file_id = $1 OR folder_id = (SELECT folder_id FROM mh_files WHERE id = $1)) AND revoked_at IS NULL`, [ref.id]);
                    await tx.exec('UPDATE mh_agent_grants SET revoked_at = coalesce(revoked_at, now()::text) WHERE file_id = $1 AND revoked_at IS NULL', [ref.id]);
                    await tx.exec('UPDATE mh_radio_tracks SET revoked_at = coalesce(revoked_at, now()) WHERE file_id = $1 AND revoked_at IS NULL', [ref.id]);
                }
            }
            // After commit, let the service re-send Search what it may keep (a tombstone once a video leaves Everyone).
            if (changedHook && tx.afterCommit) tx.afterCommit(() => { try { changedHook(ref, audience); } catch {} });
        },
    });
    // Media binds drive bytes to their original owner. Moving only this database row would let that person's
    // later account deletion remove a file someone else now owns, so reject a transfer until Media can move it too.
    const rawTransfer = shares.transfer.bind(shares);
    shares.transfer = (viewer, ref, input) => {
        if (ref.kind === 'download') throw new ShareError(409, 'share.transfer_unavailable', 'This file cannot be transferred yet');
        return rawTransfer(viewer, ref, input);
    };

    const sv = (viewer) => shareViewer(viewer);
    const at = (kind, id) => refOf(kind, id);

    async function defaultAudience(owner, kind) {
        if (!KINDS.includes(kind)) throw new Error('Unknown share kind');
        const table = kind === 'download' ? 'mh_share_defaults' : 'mh_content_share_defaults';
        const row = await db.maybe(`SELECT audience FROM ${table} WHERE owner = $1 AND kind = $2`, [owner, kind]);
        return row ? row.audience : 'public';
    }
    async function setDefaultAudience(owner, kind, audience) {
        if (!KINDS.includes(kind) || !AUDIENCES.includes(audience)) throw new Error('Invalid share default');
        const table = kind === 'download' ? 'mh_share_defaults' : 'mh_content_share_defaults';
        await db.exec(`INSERT INTO ${table} (owner, kind, audience) VALUES ($1, $2, $3)
            ON CONFLICT (owner, kind) DO UPDATE SET audience = excluded.audience, updated_at = now()`, [owner, kind, audience]);
    }
    async function applyDefault(owner, kind, audience) {
        if (!KINDS.includes(kind) || !AUDIENCES.includes(audience)) throw new Error('Invalid share default');
        const queries = {
            picture: "SELECT id, audience FROM pics_images WHERE owner = $1 AND state = 'active'",
            album: 'SELECT id, audience FROM pics_albums WHERE owner = $1',
            video: "SELECT id, visibility FROM video_uploads WHERE owner = $1 AND state = 'active'",
            download: 'SELECT id FROM mh_files WHERE owner = $1 AND deleted_at IS NULL AND binned_at IS NULL',
        };
        const rows = await db.many(queries[kind], [owner]);
        const viewer = { subject: subjectOf(owner) };
        let changed = 0;
        for (const row of rows) {
            const current = await db.maybe('SELECT audience, owner_subject FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, kind, row.id]);
            if (current && (current.owner_subject.type !== 'user' || current.owner_subject.id !== subjectOf(owner).id)) continue;
            if (!current) {
                const oldAudience = kind === 'video' ? TO_SDK[row.visibility] || 'private' : row.audience || 'private';
                await shares.register(at(kind, row.id), { owner_subject: subjectOf(owner), audience: oldAudience });
                if (oldAudience === audience) continue;
            }
            if (current && current.audience !== audience) { await shares.setAudience(viewer, at(kind, row.id), audience); changed++; }
            else if (!current) { await shares.setAudience(viewer, at(kind, row.id), audience); changed++; }
        }
        return changed;
    }

    return {
        shares,
        SERVICE, KINDS, AUDIENCES, TO_SDK, FROM_SDK, refOf, shareViewer, subjectOf,
        /** Register an upload or album with the sharing system, Everyone unless asked otherwise. */
        register: async (requester, kind, id, audience = 'public') => await shares.register(at(kind, id), {
            owner_subject: subjectOf(requester) || { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'public',
        }),
        defaultAudience, setDefaultAudience, applyDefault,
        shareOf: async (kind, id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, String(kind), String(id)]),
        canView: async (viewer, kind, id) => {
            const person = sv(viewer);
            if (await shares.canView(person, at(kind, id))) return true;
            // A named album reader can open pictures that follow that album's People audience.
            // A picture narrowed to Only me keeps its own veto, even inside a shared album.
            if (kind !== 'picture') return false;
            const picture = await db.maybe('SELECT audience FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, 'picture', id]);
            if (!picture || picture.audience !== 'people') return false;
            const albums = await db.many(`SELECT a.id FROM pics_album_images ai JOIN pics_albums a ON a.id = ai.album_id
                WHERE ai.image_id = $1 AND a.audience = 'people'`, [id]);
            for (const album of albums) if (await shares.canView(person, at('album', album.id))) return true;
            return false;
        },
        canEdit: async (viewer, kind, id) => await shares.canEdit(sv(viewer), at(kind, id)),
        get: async (viewer, kind, id) => await shares.get(sv(viewer), at(kind, id)),
        getWithRevision: async (viewer, kind, id) => await shares.getWithRevision(sv(viewer), at(kind, id)),
        /** Called after a change commits (the video search index kicks itself). */
        onChanged: (fn) => { changedHook = fn; },
        setAudience: async (viewer, kind, id, audience) => await shares.setAudience(sv(viewer), at(kind, id), TO_SDK[audience] || 'public'),
        addMembers: async (viewer, kind, id, list) => await shares.addMembers(sv(viewer), at(kind, id), list),
        removeMember: async (viewer, kind, id, subject) => await shares.removeMember(sv(viewer), at(kind, id), subject),
        update: async (viewer, kind, id, body, opts) => await shares.update(sv(viewer), at(kind, id), body, opts),
        requestAccess: async (viewer, kind, id) => await shares.requestAccess(sv(viewer), at(kind, id)),
        dismiss: async (viewer, kind, id, requestId) => await shares.dismiss(sv(viewer), at(kind, id), requestId),
        transfer: async (viewer, kind, id, input) => await shares.transfer(sv(viewer), at(kind, id), input),
        accept: async (viewer, kind, id, transferId) => await shares.accept(sv(viewer), at(kind, id), transferId),
        decline: async (viewer, kind, id, transferId) => await shares.decline(sv(viewer), at(kind, id), transferId),
        cancel: async (viewer, kind, id, transferId) => await shares.cancel(sv(viewer), at(kind, id), transferId),
        lookup: async (viewer, name) => await shares.lookup(sv(viewer), name),
        sharedWithMe: async (viewer, opts) => await shares.sharedWithMe(sv(viewer), { service: SERVICE, ...(opts || {}) }),
        work: async ({ flush = true } = {}) => {
            let expired = 0;
            try { expired = await shares.expireMembers(); } catch (err) { log.warn('[Sharing] expiry sweep:', err.message); }
            let sent = 0;
            if (flush) { try { sent = await shares.flush(); } catch (err) { log.warn('[Sharing] deliveries:', err.message); } }
            return { expired, sent };
        },
    };
}

/** The uniform API's describe(ref): the sheet shows the upload's title and link to its owner. */
function describeRef(db, config) {
    return async (ref) => {
        if (ref.service !== SERVICE) return {};
        const base = String(config.baseUrl || '').replace(/\/+$/, '');
        if (ref.kind === 'picture') {
            const row = await db.maybe('SELECT id, slug, title FROM pics_images WHERE id = $1 AND state <> $2', [ref.id, 'removed']);
            if (!row) return {};
            return { title: row.title || 'A picture', link: `${base}/i/${row.slug}`, roles: ['viewer'], audiences: AUDIENCES, transferable: true };
        }
        if (ref.kind === 'album') {
            const row = await db.maybe('SELECT id, slug, title FROM pics_albums WHERE id = $1', [ref.id]);
            if (!row) return {};
            return { title: row.title || 'An album', link: `${base}/a/${row.slug}`, roles: ['viewer'], audiences: AUDIENCES, transferable: true };
        }
        if (ref.kind === 'video') {
            const row = await db.maybe('SELECT id, watch_id, title FROM video_uploads WHERE id = $1', [ref.id]);
            if (!row) return {};
            return { title: row.title || 'A video', link: `${base}${row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`}`, roles: ['viewer'], audiences: AUDIENCES, transferable: true };
        }
        if (ref.kind === 'download') {
            const row = await db.maybe('SELECT id, name FROM mh_files WHERE id = $1 AND deleted_at IS NULL AND binned_at IS NULL', [ref.id]);
            if (!row) return {};
            return { title: row.name, link: `${base}/files/${row.id}`, roles: ['viewer'], audiences: AUDIENCES, transferable: false };
        }
        return {};
    };
}

module.exports = { createSharing, describeRef, shareViewer, subjectOf, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KINDS };
