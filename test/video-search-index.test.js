'use strict';
/**
 * OpenVibe.Video uploads in OpenVibe.Search (server/video/search-index.js), against a stand-in Search owner API:
 *   - a public, ready, active upload is a valid search.index-document@1 (owner media-hub, type video, /u/<id>);
 *   - private, unlisted, unfinished or hidden uploads are not sent; an unchanged one is not sent again;
 *   - an edit is re-sent one revision up; an upload made private (or removed) is tombstoned.
 */
const assert = require('assert');
const http = require('http');
const { validate } = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createVideoSearchIndex } = require('../server/video/search-index');

function startSearch() {
    const docs = new Map();
    const calls = [];
    const server = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
            const u = new URL(req.url, 'http://search.test');
            calls.push(`${req.method} ${u.pathname}`);
            const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
            if (req.headers.authorization !== 'Bearer svc-search') return send(401, { code: 'token.invalid' });
            if (req.method === 'GET' && u.pathname === '/api/v1/owners/media-hub/documents') {
                return send(200, { documents: [...docs.values()].map((d) => ({ type: d.type, id: d.id, revision: d.revision, deleted: Boolean(d.deleted) })), next_after: null });
            }
            const m = /^\/api\/v1\/documents\/media-hub\/video\/([^/]+)$/.exec(u.pathname);
            if (m && req.method === 'PUT') {
                const doc = { ...JSON.parse(raw), owner: 'media-hub', type: 'video', id: decodeURIComponent(m[1]) };
                const v = validate('search.index-document@1', doc);
                if (!v.valid) return send(422, { code: 'search.bad_document', errors: v.errors });
                docs.set(doc.id, doc);
                return send(200, { outcome: 'applied', revision: doc.revision });
            }
            if (m && req.method === 'DELETE') {
                const id = decodeURIComponent(m[1]);
                docs.set(id, { type: 'video', id, revision: Number(u.searchParams.get('revision')), deleted: true });
                return send(200, { outcome: 'applied' });
            }
            return send(404, { code: 'route.not_found' });
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ docs, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

(async () => {
    const search = await startSearch();
    const t = await boot({ env: {} });
    const s = t.ctx.s;
    const insert = (id, o = {}) => s.db.exec(
        `INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, content_type, size_bytes, part_size, parts_expected, status, state, created_at, updated_at, ready_at, duration_seconds)
         VALUES ($1, 'user:usr_01J0000000000000000000000K', 'kim', $2, $3, $4, 'video/mp4', 100, 100, 1, $5, $6, '2026-10-15T10:00:00.000Z', '2026-10-15T10:00:00.000Z', '2026-10-15T10:05:00.000Z', 125)`,
        [id, o.title || 'Trip to the coast', o.description || 'Waves and wind.', o.visibility || 'public', o.status || 'ready', o.state || 'active']);
    const ids = { pub: 'vup_01J0000000000000000000000A', priv: 'vup_01J0000000000000000000000B', proc: 'vup_01J0000000000000000000000C', hidden: 'vup_01J0000000000000000000000D' };
    await insert(ids.pub);
    await insert(ids.priv, { visibility: 'private' });
    await insert(ids.proc, { status: 'processing' });
    await insert(ids.hidden, { state: 'hidden' });
    const index = createVideoSearchIndex({
        s, config: { ...t.config, search: { url: search.url } }, videoAi: null,
        tokens: { authHeaders: async () => ({ authorization: 'Bearer svc-search' }) },
        log: { warn() {} },
    });

    await check('only the public, ready, active upload is sent, as a valid document', async () => {
        assert.ok(index.enabled);
        const r = await index.run();
        assert.strictEqual(r.upserted, 1, JSON.stringify(r));
        assert.deepStrictEqual([...search.docs.keys()], [ids.pub]);
        const doc = search.docs.get(ids.pub);
        assert.strictEqual(doc.canonical_url, `https://openvibe.video/u/${ids.pub}`);
        assert.strictEqual(doc.title, 'Trip to the coast');
        assert.deepStrictEqual(doc.facets, { kind: 'upload', channel: 'kim', minutes: 2 });
        assert.strictEqual(doc.revision, 1);
    });

    await check('unchanged is not sent again; an edit goes one revision up; made private, it is tombstoned', async () => {
        const before = search.calls.filter((c) => c.startsWith('PUT')).length;
        await index.run();
        assert.strictEqual(search.calls.filter((c) => c.startsWith('PUT')).length, before, 'nothing changed, nothing sent');
        await s.db.exec("UPDATE video_uploads SET title = 'Coast trip' WHERE id = $1", [ids.pub]);
        await index.run();
        assert.strictEqual(search.docs.get(ids.pub).revision, 2);
        assert.strictEqual(search.docs.get(ids.pub).title, 'Coast trip');
        await s.db.exec("UPDATE video_uploads SET visibility = 'private' WHERE id = $1", [ids.pub]);
        const r = await index.run();
        assert.strictEqual(r.deleted, 1);
        assert.deepStrictEqual(search.docs.get(ids.pub), { type: 'video', id: ids.pub, revision: 3, deleted: true });
        assert.strictEqual(Number(await s.db.value('SELECT count(*) FROM video_search_state')), 0);
    });

    await check('off without a Search URL', async () => {
        const off = createVideoSearchIndex({ s, config: { ...t.config, search: { url: '' } } });
        assert.strictEqual(off.enabled, false);
        assert.strictEqual(await off.run(), null);
    });

    await t.close();
    await search.close();
    done();
})();
