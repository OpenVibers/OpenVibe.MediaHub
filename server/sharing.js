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
const { createShares } = require('openvibe-sdk/share');
const { serviceAuth } = require('openvibe-contracts');

const SERVICE = 'mediahub';
const KINDS = ['picture', 'album', 'video', 'download'];
const AUDIENCES = ['public', 'link', 'people', 'private'];
/** MediaHub's thread words to the SDK's (there is no column to keep in step). */
const TO_SDK = { public: 'public', unlisted: 'link', private: 'private' };
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

function createSharing({ db, config, outbox, now = Date.now, fetchImpl = globalThis.fetch, log = console } = {}) {
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
                await tx.exec('UPDATE video_uploads SET visibility = $1 WHERE id = $2', [vis, ref.id]);
            }
            // After commit, let the service re-send Search what it may keep (a tombstone once a video leaves Everyone).
            if (changedHook && tx.afterCommit) tx.afterCommit(() => { try { changedHook(ref, audience); } catch {} });
        },
    });

    const sv = (viewer) => shareViewer(viewer);
    const at = (kind, id) => refOf(kind, id);

    return {
        shares,
        SERVICE, KINDS, AUDIENCES, TO_SDK, FROM_SDK, refOf, shareViewer, subjectOf,
        /** Register an upload or album with the sharing system, Everyone unless asked otherwise. */
        register: async (requester, kind, id, audience = 'public') => await shares.register(at(kind, id), {
            owner_subject: subjectOf(requester) || { type: 'service', id: SERVICE },
            audience: TO_SDK[audience] || 'public',
        }),
        shareOf: async (kind, id) => await db.maybe('SELECT * FROM shares WHERE service = $1 AND kind = $2 AND resource_id = $3', [SERVICE, String(kind), String(id)]),
        canView: async (viewer, kind, id) => await shares.canView(sv(viewer), at(kind, id)),
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
        return {};
    };
}

module.exports = { createSharing, describeRef, shareViewer, subjectOf, refOf, AUDIENCES, TO_SDK, FROM_SDK, SERVICE, KINDS };
