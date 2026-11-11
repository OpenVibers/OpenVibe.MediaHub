'use strict';

/** Community's thread for a MediaHub upload, addressed through this item's visibility checks. */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

class CommentError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function createCommentsClient({ config, fetchImpl = globalThis.fetch, refOf = (row) => ({ service: 'media-hub', type: 'video', id: String(row.id), label: String(row.title || 'Video').slice(0, 200) }) } = {}) {
    const origin = (process.env.OV_COMMUNITY_INTERNAL_URL || 'http://127.0.0.1:4200').replace(/\/+$/, '');
    let tokens = null;
    const ref = refOf;
    async function call(method, path, { subject = null, staff = false, body = null, ip = null } = {}) {
        let token;
        try {
            if (!tokens) tokens = createServiceTokenClient({ tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId,
                clientSecret: config.oauth.clientSecret, audience: 'openvibe.community', fetch: fetchImpl });
            token = await tokens.getToken();
        } catch { throw new CommentError(503, 'Comments are unavailable right now'); }
        const form = body instanceof FormData;
        let res;
        try {
            res = await fetchImpl(`${origin}/api/v1/comments${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(form ? 120000 : 5000),
                headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, ...(subject ? { 'X-OV-Subject': subject } : {}),
                    ...(staff ? { 'X-OV-Staff': '1' } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}),
                    ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
                body: form ? body : body ? JSON.stringify(body) : undefined });
        } catch { throw new CommentError(503, 'Comments are unavailable right now'); }
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new CommentError(res.status, data && (data.detail || data.error) || 'Comments are unavailable right now');
        return data;
    }
    async function thread(row, ip) {
        const data = await call('POST', '/threads/resolve', { body: { ref: ref(row) }, ip });
        const id = data && data.thread && data.thread.access_id;
        if (!/^cth_[A-Za-z0-9_-]{22}$/.test(String(id || ''))) throw new CommentError(503, 'Comments are unavailable right now');
        return id;
    }
    async function read(row, { subject = null, staff = false, sort = 'top', after = null, parent = null, limit = 30, ip = null } = {}) {
        const id = await thread(row, ip);
        const q = new URLSearchParams({ sort, limit: String(limit) });
        if (after) q.set('after', after);
        if (parent) q.set('parent', parent);
        const answer = await call('GET', `/threads/${id}?${q}`, { subject, staff, ip });
        if (answer.thread && answer.thread.visibility === 'hidden' && !staff) throw new CommentError(404, 'Comments are hidden here');
        return answer;
    }
    async function upload(row, subject, file, ip) {
        const form = new FormData();
        form.set('ref', JSON.stringify(ref(row)));
        form.set('file', file, file.name || 'file');
        return await call('POST', '/attachments', { subject, body: form, ip });
    }
    async function add(row, subject, body, ip) {
        const id = await thread(row, ip);
        return await call('POST', `/threads/${id}/comments`, { subject, body, ip });
    }
    async function remove(row, subject, staff, commentId, ip) {
        const found = await call('GET', `/${encodeURIComponent(commentId)}`, { subject, staff, ip });
        const linked = found && found.thread && found.thread.ref;
        const expected = ref(row);
        if (!linked || linked.service !== expected.service || linked.type !== expected.type || linked.id !== expected.id) throw new CommentError(404, 'Comment not found');
        if (!staff && (!found.comment.author || found.comment.author.subject !== subject)) throw new CommentError(403, 'Only the author can remove this comment');
        return await call('DELETE', `/${encodeURIComponent(commentId)}`, { subject, staff, ip });
    }
    return { read, upload, add, remove, CommentError };
}

module.exports = { createCommentsClient, CommentError };
