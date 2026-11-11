'use strict';

// Pics keeps picture visibility and the person's session; Community owns the discussion.
const ORIGIN = 'https://openvibe.community';

function createCommentsClient({ fetchImpl = globalThis.fetch } = {}) {
    async function call(method, path, { token = null, body } = {}) {
        const form = body instanceof FormData;
        let response;
        try {
            response = await fetchImpl(`${ORIGIN}/api/v1/comments${path}`, {
                method, redirect: 'error', signal: AbortSignal.timeout(form ? 120_000 : 5000),
                headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
                body: form ? body : body ? JSON.stringify(body) : undefined,
            });
        } catch { return { status: 503, body: { error: 'Comments are unavailable right now' } }; }
        const data = await response.json().catch(() => null);
        return { status: response.status, body: data || { error: 'Comments are unavailable right now' } };
    }
    const ref = (id) => ({ service: 'pics', type: 'picture', id: String(id) });
    async function thread(id, token) {
        const result = await call('POST', '/threads/resolve', { token, body: { ref: ref(id) } });
        return result.status < 300 && result.body.thread ? result.body.thread : result;
    }
    async function read(id, token, query = {}) {
        const found = await thread(id, token);
        if (!found.id) return found;
        const qs = new URLSearchParams();
        if (query.sort === 'new' || query.sort === 'top') qs.set('sort', query.sort);
        if (query.after && /^(?:-?\d{1,12}:)?\d{1,15}$/.test(String(query.after))) qs.set('after', String(query.after));
        if (query.parent && /^\d{1,15}$/.test(String(query.parent))) qs.set('parent', String(query.parent));
        if (query.limit) qs.set('limit', String(Math.min(Math.max(Number(query.limit) || 30, 1), 100)));
        return await call('GET', `/threads/${encodeURIComponent(found.id)}${qs.size ? `?${qs}` : ''}`, { token });
    }
    async function add(id, token, body) {
        const found = await thread(id, token);
        if (!found.id) return found;
        return await call('POST', `/threads/${encodeURIComponent(found.id)}/comments`, { token, body });
    }
    async function upload(id, token, buffer, name, mime) {
        const form = new FormData();
        form.set('ref', JSON.stringify(ref(id)));
        form.set('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), name || 'file');
        return await call('POST', '/attachments', { token, body: form });
    }
    async function remove(commentId, token) {
        return await call('DELETE', `/${encodeURIComponent(commentId)}`, { token });
    }
    async function replies(id, token, parent) {
        const all = [];
        let after = null;
        while (true) {
            const result = await read(id, token, { parent, after, limit: 100 });
            if (result.status !== 200) return result;
            all.push(...result.body.comments);
            if (!result.body.next_cursor) return { status: 200, body: { replies: all } };
            if (result.body.next_cursor === after) return { status: 503, body: { error: 'Replies could not be loaded' } };
            after = result.body.next_cursor;
        }
    }
    return { read, add, upload, remove, replies };
}

module.exports = { createCommentsClient };
