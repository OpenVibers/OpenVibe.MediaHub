'use strict';

/**
 * OpenVibe.Media: where the bytes live. MediaHub calls Media's object API v2 **server-side only**, with its own
 * app key (audience `media-hub`), and never hands that key, an upload token or a signed URL to a browser.
 *
 *   init({ size, contentType, name, ownerSubject, multipart })  POST  /api/v2/media-hub/objects
 *   putContent(objectId, buffer)                                PUT   …/objects/:id/content
 *   complete(objectId)                                          POST  …/objects/:id/complete
 *   multipartStatus(objectId, uploadId)                         GET   …/objects/:id/multipart/:uploadId
 *   putPart(objectId, uploadId, n, buffer)                      PUT   …/objects/:id/multipart/:uploadId/parts/:n
 *   completeMultipart(objectId, uploadId)                       POST  …/objects/:id/multipart/:uploadId/complete
 *   abortMultipart(objectId, uploadId)                          DELETE …/objects/:id/multipart/:uploadId
 *   get(objectId)                                               GET   …/objects/:id
 *   downloadUrl(objectId)                                       GET   …/objects/:id/download
 *   bytes(objectId, { range })                                  GET   <signed URL on the Media host>
 *   remove(objectId)                                            DELETE …/objects/:id   (a soft delete in Media)
 *
 * Two details worth knowing. Media answers a private object's download with a signed URL on its *public* origin;
 * this client rewrites that URL onto the configured Media host before fetching it, so the bytes are read from the
 * one address MEDIAHUB_MEDIA_URL names and never from a URL a caller supplied. And a Media call never throws for
 * a refusal: it answers { ok: false, status, code, detail } so the caller can show the problem as it came.
 */
const { ids } = require('openvibe-contracts');
const { headerSafeName } = require('../drive/rules');

/** A user subject as Media wants it in X-OV-Subject: the bare usr_…, or null when it cannot be one. */
function subjectHeader(requester) {
    const parsed = ids.parseSubject(String(requester || ''));
    if (parsed && parsed.type === 'user') return parsed.id;
    const bare = String(requester || '').replace(/^user:/, '');
    return ids.isSubjectId('user', bare) ? bare : null;
}

function createMediaClient({ config, fetchImpl = globalThis.fetch, log = console }) {
    const media = config.media;
    const base = () => `${media.url}/api/v2/${encodeURIComponent(media.app)}/objects`;
    const enabled = Boolean(media.appKey);

    /** One JSON call. Never throws for a Media refusal; throws only when Media cannot be reached at all. */
    async function call(path, { method = 'GET', body, json, headers = {}, raw = false } = {}) {
        if (!enabled) return { ok: false, status: 503, code: 'media.not_configured', detail: 'MEDIAHUB_MEDIA_APP_KEY is not set' };
        const h = { Accept: 'application/json', Authorization: `Bearer ${media.appKey}`, ...headers };
        let payload = body;
        if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = 'application/json'; }
        let res;
        try {
            res = await fetchImpl(`${base()}${path}`, { method, headers: h, body: payload, signal: AbortSignal.timeout(media.timeoutMs) });
        } catch (err) {
            log.warn('[MediaHub] Media did not answer:', (err && err.name) || '', (err && err.message) || '');
            return { ok: false, status: 502, code: 'media.unreachable', detail: 'OpenVibe.Media did not answer' };
        }
        if (raw) return { ok: res.ok, status: res.status, res };
        const data = await res.json().catch(() => null);
        if (!res.ok) {
            const p = (data && (data.problem || data)) || {};
            return { ok: false, status: res.status, code: p.code || `media.http_${res.status}`, detail: p.detail || 'OpenVibe.Media refused the request' };
        }
        return { ok: true, status: res.status, data };
    }

    return {
        enabled,

        /** Start an object. Media gives it back `uploading` until its bytes arrive and it is completed. */
        async init({ size, contentType, name, ownerSubject, multipart = false, partSize = null }) {
            const subject = subjectHeader(ownerSubject);
            if (!subject) return { ok: false, status: 400, code: 'file.bad_owner', detail: 'a file belongs to a person with a canonical subject' };
            return await call('', {
                method: 'POST',
                headers: { 'X-OV-Subject': subject },
                json: {
                    kind: 'file', visibility: 'private', size_bytes: size,
                    // Media only needs a label: the real name (any script) is MediaHub's, and Media's own download
                    // header takes a filename as is, so it gets the printable-ASCII rendering.
                    mime_type: contentType || null, filename: headerSafeName(name), multipart: multipart === true,
                    ...(multipart && partSize ? { part_size: partSize } : {}),
                },
            });
        },

        /** The bytes of a single-part upload (exactly `size` bytes). */
        async putContent(objectId, buffer) {
            return await call(`/${encodeURIComponent(objectId)}/content`, {
                method: 'PUT', body: buffer,
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) },
            });
        },

        complete: (objectId) => call(`/${encodeURIComponent(objectId)}/complete`, { method: 'POST', json: {} }),

        /** A fresh multipart session for an object created without one (or whose session expired). */
        multipartStart: (objectId, { size, partSize }) => call(`/${encodeURIComponent(objectId)}/multipart`, { method: 'POST', json: { size_bytes: size, part_size: partSize } }),

        multipartStatus: (objectId, uploadId) => call(`/${encodeURIComponent(objectId)}/multipart/${encodeURIComponent(uploadId)}`),

        putPart: (objectId, uploadId, n, buffer) => call(`/${encodeURIComponent(objectId)}/multipart/${encodeURIComponent(uploadId)}/parts/${Number(n)}`, {
            method: 'PUT', body: buffer,
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) },
        }),

        completeMultipart: (objectId, uploadId) => call(`/${encodeURIComponent(objectId)}/multipart/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', json: {} }),

        abortMultipart: (objectId, uploadId) => call(`/${encodeURIComponent(objectId)}/multipart/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }),

        get: (objectId) => call(`/${encodeURIComponent(objectId)}`),

        remove: (objectId) => call(`/${encodeURIComponent(objectId)}`, { method: 'DELETE' }),

        /**
         * Media's short-lived signed URL for an object's bytes, rewritten onto the configured Media host.
         * The signature covers the object id and the expiry, not the host, so the bytes are read from
         * MEDIAHUB_MEDIA_URL — the only host this service fetches bytes from.
         */
        async downloadUrl(objectId) {
            const r = await call(`/${encodeURIComponent(objectId)}/download?format=json`);
            if (!r.ok) return r;
            const url = r.data && r.data.url;
            if (!url) return { ok: false, status: 502, code: 'media.no_url', detail: 'OpenVibe.Media gave no download URL' };
            let rewritten;
            try {
                const u = new URL(url);
                rewritten = `${media.url}/o/${encodeURIComponent(objectId)}${u.search}`;
            } catch {
                return { ok: false, status: 502, code: 'media.no_url', detail: 'OpenVibe.Media gave an unusable download URL' };
            }
            return { ok: true, status: 200, url: rewritten, expires_at: (r.data && r.data.expires_at) || null };
        },

        /**
         * The object's bytes, streamed. `range` (a Range header value) is passed through, so a browser can
         * resume a download; the caller answers 206 from the upstream status and Content-Range.
         */
        async bytes(objectId, { range = null } = {}) {
            const signed = await this.downloadUrl(objectId);
            if (!signed.ok) return signed;
            try {
                const res = await fetchImpl(signed.url, {
                    headers: { ...(range ? { Range: String(range) } : {}) },
                    redirect: 'follow',   // Media may hand the read to its own storage provider; that is Media's choice
                    signal: AbortSignal.timeout(media.timeoutMs),
                });
                return { ok: res.ok || res.status === 206, status: res.status, res };
            } catch (err) {
                log.warn('[MediaHub] Media bytes fetch failed:', (err && err.message) || '');
                return { ok: false, status: 502, code: 'media.unreachable', detail: 'OpenVibe.Media did not answer' };
            }
        },
    };
}

module.exports = { createMediaClient, subjectHeader };
