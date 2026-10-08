'use strict';
/**
 * A stand-in for OpenVibe.Media: a small local HTTP server that implements exactly the object-API v2 endpoints
 * MediaHub calls, with Media's own behaviour where it matters to this service:
 *
 *   POST   /api/v2/:app/objects                          init (single-part or a multipart session)
 *   PUT    /api/v2/:app/objects/:id/content              the bytes, exactly size_bytes of them
 *   POST   /api/v2/:app/objects/:id/complete             hash, size and lifecycle → ready
 *   POST   /api/v2/:app/objects/:id/multipart            (re)start a session
 *   GET    /api/v2/:app/objects/:id/multipart/:uid       parts received and what is missing (resume)
 *   PUT    /api/v2/:app/objects/:id/multipart/:uid/parts/:n   one part, exactly part_size bytes (the last less)
 *   POST   /api/v2/:app/objects/:id/multipart/:uid/complete   assemble into the object
 *   DELETE /api/v2/:app/objects/:id/multipart/:uid       abort
 *   GET    /api/v2/:app/objects/:id                      metadata
 *   GET    /api/v2/:app/objects/:id/download             a short-lived signed URL (host-independent signature)
 *   DELETE /api/v2/:app/objects/:id                      soft delete
 *   GET    /o/:id?exp&sig                                the bytes, with the signature checked
 *
 * The app key is required on everything under /api/v2 (x-ov-subject names the owner at init), exactly as Media
 * requires it, so a test can prove MediaHub never asks Media for anything with the wrong credential. `.requests`
 * records every call ({ method, path, query, authorization, subject, bytes }) for the assertions that need it.
 *
 * Behaviour knobs: `setDown(true)` makes every call answer 503; `setKeyRejects(true)` answers 401 as a bad key
 * would; `objects`/`bytesOf(id)` are what the store holds; `deleted` lists the ids Media was asked to delete.
 */
const http = require('http');
const crypto = require('crypto');
const { ids } = require('openvibe-contracts');

const KEY = 'media-hub-test-key';
const SIGN_SECRET = 'stand-in-media-signing-secret';

const sign = (objectId, exp) => crypto.createHmac('sha256', SIGN_SECRET).update(`get\n${objectId}\n${exp}`).digest('base64url');

async function startMedia({ key = KEY, maxSingle = 256 * 1024 * 1024 } = {}) {
    const objects = new Map();     // id → { id, size_bytes, mime_type, content_hash, lifecycle_status, visibility, owner_subject, filename, bytes }
    const sessions = new Map();    // id → { id, object_id, part_size, total_size, parts_expected, status, parts: Map }
    const requests = [];
    const deleted = [];
    const state = { down: false, keyRejects: false };
    let seq = 0;

    const json = (res, status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    };
    const problem = (res, status, code, detail) => json(res, status, { type: `https://openvibe.media/problems/${code}`, title: 'Error', status, code, detail });

    const readRaw = (req) => new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });

    const publicObject = (o) => ({
        id: o.id, kind: 'file', visibility: o.visibility, lifecycle_status: o.lifecycle_status,
        mime_type: o.mime_type, size_bytes: o.size_bytes, content_hash: o.content_hash,
        owner: { subject: o.owner_subject }, metadata: { filename: o.filename },
        created_at: o.created_at, updated_at: o.created_at, deleted_at: o.deleted_at || null,
    });

    const sessionPublic = (sess, { parts = true } = {}) => {
        const out = {
            upload_id: sess.id, object_id: sess.object_id, status: sess.status,
            part_size: sess.part_size, total_size: sess.total_size, parts_expected: sess.parts_expected,
            expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: sess.created_at,
        };
        if (parts) {
            const have = [...sess.parts.keys()].sort((a, b) => a - b);
            out.parts = have.map((n) => ({ part_number: n, size_bytes: sess.parts.get(n).length, sha256: sha256(sess.parts.get(n)) }));
            out.received_bytes = have.reduce((a, n) => a + sess.parts.get(n).length, 0);
            out.missing = [];
            for (let n = 1; n <= sess.parts_expected; n++) if (!sess.parts.has(n)) out.missing.push(n);
        }
        return out;
    };

    const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
    const partSize = (sess, n) => (n < sess.parts_expected ? sess.part_size : sess.total_size - sess.part_size * (sess.parts_expected - 1));

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://x');
        const raw = req.method === 'PUT' || req.method === 'POST' ? await readRaw(req) : Buffer.alloc(0);
        const path = url.pathname;
        const entry = { method: req.method, path, query: url.search, authorization: req.headers.authorization || null, subject: req.headers['x-ov-subject'] || null, bytes: raw.length };
        requests.push(entry);
        if (state.down) return problem(res, 503, 'media.down', 'Media is restarting');
        if (!path.startsWith('/api/v2/') && !path.startsWith('/o/')) return problem(res, 404, 'route.not_found', 'no such route');

        // ── The public bytes of an object (/o/:id), signature-checked like Media checks it ──
        if (path.startsWith('/o/')) {
            const id = decodeURIComponent(path.slice(3));
            const obj = objects.get(id);
            const exp = Number(url.searchParams.get('exp'));
            const sig = url.searchParams.get('sig') || '';
            const signed = Number.isInteger(exp) && exp * 1000 > Date.now() && sig === sign(id, exp);
            if (!obj || obj.visibility === 'private' && !signed) return problem(res, 404, 'media.object.not_found', 'No such object');
            if (obj.lifecycle_status === 'deleted') return problem(res, 410, 'media.object.deleted', 'Gone');
            if (obj.lifecycle_status !== 'ready') return problem(res, 404, 'media.object.not_found', 'No such object');
            const name = String(obj.filename || obj.id).replace(/["\\\r\n]/g, '_');
            const headers = {
                'Content-Type': obj.mime_type || 'application/octet-stream',
                'Content-Disposition': `attachment; filename="${name}"`,
                'X-Content-Type-Options': 'nosniff',
                'Accept-Ranges': 'bytes',
            };
            // A Range read, as Media serves one for a packed or large object.
            const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
            if (range && (range[1] || range[2])) {
                const start = range[1] ? Number(range[1]) : Math.max(0, obj.bytes.length - Number(range[2]));
                const end = range[1] && range[2] ? Math.min(Number(range[2]), obj.bytes.length - 1) : obj.bytes.length - 1;
                const slice = obj.bytes.subarray(start, end + 1);
                res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${obj.bytes.length}`, 'Content-Length': String(slice.length) });
                return res.end(slice);
            }
            res.writeHead(200, { ...headers, 'Content-Length': String(obj.bytes.length) });
            return res.end(obj.bytes);
        }

        // ── Everything else is the tenant API, and needs the app key ──
        const keyed = String(req.headers.authorization || '').startsWith('Bearer ') ? String(req.headers.authorization).slice(7) : null;
        if (state.keyRejects || keyed !== key) return problem(res, 401, 'auth.required', 'Authentication required');

        const rest = path.replace(/^\/api\/v2\//, '').split('/').filter(Boolean).map(decodeURIComponent);
        if (rest.length < 2 || rest[1] !== 'objects') return problem(res, 404, 'route.not_found', 'no such route');
        const tail = rest.slice(2);
        const parseJson = () => { try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return null; } };

        // POST /objects — init
        if (!tail.length && req.method === 'POST') {
            const body = parseJson();
            if (!body) return problem(res, 400, 'media.object.invalid', 'body is not JSON');
            const size = Number(body.size_bytes);
            if (!Number.isInteger(size) || size < 1) return problem(res, 400, 'media.object.invalid', 'size_bytes must be a positive integer');
            const subject = req.headers['x-ov-subject'];
            if (!subject || !ids.isSubjectId('user', subject)) return problem(res, 400, 'media.object.invalid', 'X-OV-Subject must be a user subject');
            const wantParts = body.multipart === true;
            if (!wantParts && size > maxSingle) return problem(res, 413, 'media.object.too_large', 'Single-part uploads are limited; send multipart: true');
            seq += 1;
            const obj = {
                id: ids.newId('media', 1_700_000_000_000 + seq), visibility: body.visibility || 'private',
                lifecycle_status: 'uploading', mime_type: body.mime_type || null, size_bytes: size,
                content_hash: null, owner_subject: subject, filename: body.filename || null, bytes: null, x: true,
                created_at: new Date().toISOString(),
            };
            objects.set(obj.id, obj);
            const base = `/api/v2/${rest[0]}/objects/${obj.id}`;
            if (!wantParts) {
                const exp = Math.floor(Date.now() / 1000) + 3600;
                return json(res, 201, {
                    id: obj.id, object: publicObject(obj),
                    upload: { method: 'PUT', url: `${base}/content?token=t`, token: 't', expires_at: null, max_bytes: size, content_type: obj.mime_type, complete_url: `${base}/complete`, multipart_url: `${base}/multipart` },
                });
            }
            const sess = newSession(obj, body.part_size);
            return json(res, 201, {
                id: obj.id, object: publicObject(obj),
                upload: { method: 'multipart', url: null, token: null, expires_at: null, max_bytes: size, content_type: obj.mime_type, complete_url: `${base}/complete`, multipart_url: `${base}/multipart`, multipart: sessionPublic(sess, { parts: false }) },
            });
        }

        const obj = objects.get(tail[0]);
        if (!obj) return problem(res, 404, 'media.object.not_found', 'No such object in this namespace');
        const sub = tail.slice(1);

        // PUT /objects/:id/content
        if (!sub.length && req.method === 'PUT') {
            if (obj.lifecycle_status !== 'uploading') return problem(res, 409, 'media.object.not_uploading', `Object is ${obj.lifecycle_status}`);
            if (raw.length !== Number(obj.size_bytes)) return problem(res, 400, 'media.object.size_mismatch', `Declared ${obj.size_bytes} bytes, received ${raw.length}`);
            obj.bytes = raw;
            obj.content_hash = sha256(raw);
            return json(res, 200, { id: obj.id, size_bytes: raw.length, content_hash: obj.content_hash });
        }
        // POST /objects/:id/complete
        if (sub.length === 1 && sub[0] === 'complete' && req.method === 'POST') {
            if (!obj.bytes) return problem(res, 409, 'media.object.no_content', 'PUT the content first');
            obj.lifecycle_status = 'ready';
            return json(res, 200, publicObject(obj));
        }
        // POST /objects/:id/multipart
        if (sub.length === 1 && sub[0] === 'multipart' && req.method === 'POST') {
            const body = parseJson() || {};
            const sess = newSession(obj, body.part_size, Number(body.size_bytes) || Number(obj.size_bytes));
            return json(res, 201, sessionPublic(sess, { parts: false }));
        }
        if (sub[0] === 'multipart' && sub.length >= 2) {
            const sess = sessions.get(sub[1]);
            if (!sess || sess.object_id !== obj.id) return problem(res, 404, 'media.upload.not_found', 'No such upload for this object');
            // GET …/multipart/:uid — the resume answer
            if (sub.length === 2 && req.method === 'GET') return json(res, 200, sessionPublic(sess));
            // DELETE …/multipart/:uid — abort
            if (sub.length === 2 && req.method === 'DELETE') { sess.status = 'aborted'; sess.parts.clear(); return json(res, 200, sessionPublic(sess, { parts: false })); }
            // PUT …/multipart/:uid/parts/:n
            if (sub.length === 4 && sub[2] === 'parts' && req.method === 'PUT') {
                if (sess.status !== 'active') return problem(res, 409, 'media.upload.not_active', `The upload is ${sess.status}`);
                const n = Number(sub[3]);
                if (!Number.isInteger(n) || n < 1 || n > sess.parts_expected) return problem(res, 400, 'media.upload.invalid_part', `part_number must be 1-${sess.parts_expected}`);
                const want = partSize(sess, n);
                if (raw.length !== want) return problem(res, raw.length > want ? 413 : 400, 'media.upload.part_size_mismatch', `Part ${n} must be ${want} bytes`);
                sess.parts.set(n, raw);
                return json(res, 200, { part_number: n, size_bytes: raw.length, sha256: sha256(raw) });
            }
            // POST …/multipart/:uid/complete — assemble
            if (sub.length === 3 && sub[2] === 'complete' && req.method === 'POST') {
                if (sess.status !== 'active') return problem(res, 409, 'media.upload.not_active', `The upload is ${sess.status}`);
                const missing = [];
                for (let n = 1; n <= sess.parts_expected; n++) if (!sess.parts.has(n)) missing.push(n);
                if (missing.length) return problem(res, 409, 'media.upload.incomplete', `parts missing: ${missing.join(', ')}`);
                const parts = [];
                for (let n = 1; n <= sess.parts_expected; n++) parts.push(sess.parts.get(n));
                obj.bytes = Buffer.concat(parts);
                obj.content_hash = sha256(obj.bytes);
                obj.size_bytes = obj.bytes.length;
                obj.lifecycle_status = 'ready';
                sess.status = 'completed';
                return json(res, 200, publicObject(obj));
            }
        }
        // GET /objects/:id
        if (!sub.length && req.method === 'GET') return json(res, 200, publicObject(obj));
        // GET /objects/:id/download
        if (sub.length === 1 && sub[0] === 'download' && req.method === 'GET') {
            if (obj.lifecycle_status === 'deleted') return problem(res, 410, 'media.object.deleted', 'Object was deleted');
            if (obj.lifecycle_status !== 'ready') return problem(res, 409, 'media.object.not_ready', `Object is ${obj.lifecycle_status}`);
            const exp = Math.floor(Date.now() / 1000) + 300;
            return json(res, 200, { url: `https://media.test/o/${encodeURIComponent(obj.id)}?exp=${exp}&sig=${sign(obj.id, exp)}`, expires_at: new Date(exp * 1000).toISOString(), public: false });
        }
        // DELETE /objects/:id
        if (!sub.length && req.method === 'DELETE') {
            obj.lifecycle_status = 'deleted';
            obj.deleted_at = new Date().toISOString();
            deleted.push(obj.id);
            return json(res, 200, publicObject(obj));
        }
        return problem(res, 404, 'route.not_found', 'no such route');
    });

    function newSession(obj, requestedPartSize, total = Number(obj.size_bytes)) {
        const size = Number(requestedPartSize) || 8 * 1024 * 1024;
        seq += 1;
        const sess = {
            id: `up_${seq}${crypto.randomBytes(6).toString('hex')}`, object_id: obj.id, part_size: size,
            total_size: total, parts_expected: Math.max(1, Math.ceil(total / size)), status: 'active',
            parts: new Map(), created_at: new Date().toISOString(),
        };
        // An active session for the object is replaced, exactly as Media replaces it.
        for (const other of sessions.values()) if (other.object_id === obj.id && other.status === 'active') other.status = 'replaced';
        sessions.set(sess.id, sess);
        return sess;
    }

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, key, objects, sessions, requests, deleted, state,
        bytesOf: (id) => (objects.get(id) && objects.get(id).bytes) || null,
        objectOf: (id) => objects.get(id) || null,
        setDown: (v) => { state.down = v; },
        setKeyRejects: (v) => { state.keyRejects = v; },
        reset: () => { requests.length = 0; },
        close: () => new Promise((r) => server.close(r)),
    };
}

module.exports = { startMedia, KEY, sign };
