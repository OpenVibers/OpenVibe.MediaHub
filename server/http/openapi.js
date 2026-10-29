'use strict';
/**
 * OpenAPI 3.1 for OpenVibe.MediaHub's drive API, from the route table below.
 *
 * ROUTES is the table: every entry is one method on one path under /api/v1. server/http/api.js is
 * that router, and test/openapi.test.js walks the mounted stack and fails when the two differ in
 * either direction — so the document cannot advertise an address this service does not answer.
 *
 * Choice for the three hosts: one document, built per request. `servers` is the host the request
 * came in on first, then the other hosts this service answers for (openvibe.download, openvibe.video,
 * openvibe.pics — the code's configured Pics host; openvibe.media is OpenVibe.Media, a different
 * service). The /api/v1 surface itself is the drive API: the video and Pics hosts serve pages, not
 * /api routes, and page paths are outside /api so they do not belong in the document.
 *
 *   GET /openapi.json            this document (public, Cache-Control 5 minutes)
 *   GET /api/v1/openapi.json     308 to /openapi.json
 *
 * /api/health and /api/ready are probes; /internal/events is loopback-only. Request fields are what
 * server/http/api.js reads; response properties are its wire shapes. Nothing is inferred.
 */
const pkg = require('../../package.json');

const MOUNT = '/api/v1';
const DEFAULT_SERVERS = ['https://openvibe.download', 'https://openvibe.video', 'https://openvibe.pics'];

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: 'string', ...extra });
const nullable = (type, extra = {}) => ({ type: [type, 'null'], ...extra });
const arrayOf = (items) => ({ type: 'array', items });
const integer = (extra = {}) => ({ type: 'integer', ...extra });

const problem = {
    description: 'A problem (RFC 9457, application/problem+json): type, title, status and a stable code',
    content: {
        'application/problem+json': {
            schema: {
                type: 'object',
                required: ['type', 'title', 'status'],
                properties: { type: str(), title: str(), status: integer(), code: str(), detail: str(), request_id: str() },
            },
        },
    },
};
const errors = (codes = [400, 401, 403, 404, 409, 413, 422, 429]) => ({
    ...Object.fromEntries(codes.map((code) => [code, problem])),
    default: problem,
});

const path = (name, schema, description) => ({ name, in: 'path', required: true, schema, ...(description && { description }) });
const query = (name, schema, description) => ({ name, in: 'query', required: false, schema, ...(description && { description }) });

const PERSON = [{ bearer: [] }, { cookie: [] }];
const ANONYMOUS = [{}];

const json = (description, schema) => ({ description, ...(schema ? { content: { 'application/json': { schema } } } : {}) });
const body = (schema, required = true) => ({ required, content: { 'application/json': { schema } } });

const PATHS = {};
function route(method, p, operation) {
    (PATHS[p] = PATHS[p] || {})[method] = operation;
}

// ── Liveness ───────────────────────────────────────────────────────────────────────────────────
route('get', '/ping', {
    operationId: 'ping', summary: 'Liveness', tags: ['liveness'], security: ANONYMOUS,
    responses: { 200: json('The service answers', { type: 'object', properties: { ok: { const: true }, service: str() } }), ...errors([429]) },
});

// ── Files ──────────────────────────────────────────────────────────────────────────────────────
route('get', '/files', {
    operationId: 'listFiles', summary: 'One folder of your drive (or the root)', tags: ['files'], security: PERSON,
    description: 'A person\'s own files: no app, agent or service token can hold them. `before` is the last file id of the previous page.',
    parameters: [query('folder_id', str(), 'A folder id; absent for the root'), query('limit', integer({ minimum: 1, maximum: 200, default: 100 })), query('before', str(), 'The last file id of the previous page')],
    responses: { 200: json('The folder, its subfolders, files and usage', { type: 'object', properties: {
        folder_id: nullable('string'), folders: arrayOf(ref('Folder')), files: arrayOf(ref('File')), usage: ref('Usage'), note: str(),
    } }), ...errors() },
});
route('post', '/files', {
    operationId: 'startUpload', summary: 'Start a chunked upload (the bytes follow through /uploads/{id}/parts/{n})', tags: ['files'], security: PERSON,
    description: 'A signed-in session write must come from openvibe.download itself. 201 carries Location: /api/v1/uploads/{id}.',
    requestBody: body({ type: 'object', required: ['name', 'size'], properties: {
        name: str(), size: integer({ minimum: 0 }), content_type: str(), folder_id: str(),
    } }),
    responses: { 201: json('The upload session and what is still missing', { type: 'object', properties: { upload: { type: 'object' }, note: str() } }), ...errors() },
});
route('get', '/files/{id}', {
    operationId: 'getFile', summary: 'One of your files and its share links', tags: ['files'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 200: json('The file and its shares', { type: 'object', properties: { file: ref('File'), shares: arrayOf(ref('Share')) } }), ...errors() },
});
route('delete', '/files/{id}', {
    operationId: 'deleteFile', summary: 'Delete one of your files (and ask Media to delete the object)', tags: ['files'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 204: { description: 'Deleted' }, ...errors([401, 403, 404, 429]) },
});

// ── Folders ────────────────────────────────────────────────────────────────────────────────────
route('get', '/folders', {
    operationId: 'listFolders', summary: 'Your folders', tags: ['folders'], security: PERSON,
    responses: { 200: json('Folders', { type: 'object', properties: { folders: arrayOf(ref('Folder')) } }), ...errors() },
});
route('post', '/folders', {
    operationId: 'createFolder', summary: 'Make a folder', tags: ['folders'], security: PERSON,
    requestBody: body({ type: 'object', required: ['name'], properties: { name: str(), parent_id: str() } }),
    responses: { 201: json('The folder', { type: 'object', properties: { folder: ref('Folder') } }), ...errors([401, 403, 409, 422, 429]) },
});

// ── Shares ────────────────────────────────────────────────────────────────────────────────────
route('post', '/shares', {
    operationId: 'createShare', summary: 'Share a file or a folder with a link', tags: ['shares'], security: PERSON,
    description: 'A share link is made by the person themself (signed in, or their Network token), never by a sync key. `usernames` is an array or a whitespace/comma-separated string; `public: true` makes an anyone-with-the-link share.',
    requestBody: body({ type: 'object', properties: {
        file_id: str(), folder_id: str(), hours: integer({ minimum: 0 }), usernames: { oneOf: [str(), arrayOf(str())] }, public: { type: 'boolean' },
    } }),
    responses: { 201: json('The share and the names that did not resolve', { type: 'object', properties: { share: ref('Share'), unresolved: arrayOf(str()) } }), ...errors([401, 403, 404, 422, 429]) },
});
route('delete', '/shares/{slug}', {
    operationId: 'revokeShare', summary: 'Revoke one of your share links', tags: ['shares'], security: PERSON,
    parameters: [path('slug', str())],
    responses: { 204: { description: 'Revoked' }, ...errors([401, 403, 404, 429]) },
});
route('get', '/usage', {
    operationId: 'getUsage', summary: 'What you hold and what is left', tags: ['usage'], security: PERSON,
    responses: { 200: json('Usage and the last days', { type: 'object', properties: {
        usage: ref('Usage'), days: arrayOf({ type: 'object', properties: { day: str(), uploads: integer() } }), note: str(),
    } }), ...errors() },
});

// ── Chunked uploads ───────────────────────────────────────────────────────────────────────────
route('put', '/uploads/{id}/parts/{n}', {
    operationId: 'putUploadPart', summary: 'One part of a chunked upload (raw bytes)', tags: ['uploads'], security: PERSON,
    description: 'The body is the part\'s raw bytes, not JSON. A part is at most the service\'s part size.',
    parameters: [path('id', str()), path('n', integer({ minimum: 0 }))],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', contentEncoding: 'binary' } } } },
    responses: { 200: json('The part and the bytes received', { type: 'object', properties: { part: integer(), size: integer() } }), ...errors([401, 403, 404, 409, 413, 422]) },
});
route('get', '/uploads/{id}', {
    operationId: 'getUpload', summary: 'What a chunked upload is still missing (resume)', tags: ['uploads'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 200: json('The upload session', { type: 'object', properties: { upload: { type: 'object' } } }), ...errors([401, 403, 404, 409, 429]) },
});
route('post', '/uploads/{id}/complete', {
    operationId: 'completeUpload', summary: 'Assemble a chunked upload into a file', tags: ['uploads'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 201: json('The file', { type: 'object', properties: { file: ref('File') } }), ...errors([401, 403, 404, 409, 429]) },
});
route('delete', '/uploads/{id}', {
    operationId: 'abortUpload', summary: 'Abandon a chunked upload', tags: ['uploads'], security: PERSON,
    parameters: [path('id', str())],
    responses: { 204: { description: 'Abandoned' }, ...errors([401, 403, 404]) },
});

// ── Drops: an upload without an account ──────────────────────────────────────────────────────
route('post', '/drops', {
    operationId: 'startDrop', summary: 'Start an upload without an account', tags: ['drops'], security: ANONYMOUS,
    description: 'The token in the answer is sent as X-Drop-Token on the part and complete calls. Off unless drops are enabled here.',
    requestBody: body({ type: 'object', required: ['name', 'size'], properties: { name: str(), size: integer({ minimum: 0 }), content_type: str() } }),
    responses: { 201: json('The upload, its token and how to finish it', { type: 'object', properties: { upload: { type: 'object' }, token: str(), note: str() } }), ...errors([403, 413, 429]) },
});
route('put', '/drops/{id}/parts/{n}', {
    operationId: 'putDropPart', summary: 'One part of a drop upload (raw bytes, X-Drop-Token)', tags: ['drops'], security: ANONYMOUS,
    parameters: [path('id', str()), path('n', integer({ minimum: 0 })), { name: 'X-Drop-Token', in: 'header', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', contentEncoding: 'binary' } } } },
    responses: { 200: json('The part and the bytes received', { type: 'object', properties: { part: integer(), size: integer() } }), ...errors([403, 404, 409, 413, 422]) },
});
route('get', '/drops/{id}', {
    operationId: 'getDrop', summary: 'The state of a drop upload', tags: ['drops'], security: ANONYMOUS,
    parameters: [path('id', str()), { name: 'X-Drop-Token', in: 'header', required: true, schema: { type: 'string' } }],
    responses: { 200: json('The upload', { type: 'object', properties: { upload: { type: 'object' } } }), ...errors([403, 404]) },
});
route('post', '/drops/{id}/complete', {
    operationId: 'completeDrop', summary: 'Finish a drop upload (the delete link is shown once)', tags: ['drops'], security: ANONYMOUS,
    parameters: [path('id', str()), { name: 'X-Drop-Token', in: 'header', required: true, schema: { type: 'string' } }],
    responses: { 201: json('The drop, its delete key and delete URL', { type: 'object', properties: {
        drop: { type: 'object', properties: { slug: str(), url: str({ format: 'uri' }), name: str(), size: integer(), content_type: str(), created_at: str() } },
        delete_key: str(), delete_url: str({ format: 'uri' }), note: str(),
    } }), ...errors([403, 404, 409, 429]) },
});
route('delete', '/drops/{id}', {
    operationId: 'abortDrop', summary: 'Abandon a drop upload', tags: ['drops'], security: ANONYMOUS,
    parameters: [path('id', str()), { name: 'X-Drop-Token', in: 'header', required: true, schema: { type: 'string' } }],
    responses: { 204: { description: 'Abandoned' }, ...errors([403, 404]) },
});

function openapi({ servers = DEFAULT_SERVERS } = {}) {
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.MediaHub API',
            version: pkg.version,
            description: pkg.description,
            license: { name: 'AGPL-3.0-only', identifier: 'AGPL-3.0-only' },
            contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.MediaHub', email: 'contact@openvibe.network' },
        },
        servers: servers.map((url) => ({ url })),
        tags: ['liveness', 'files', 'folders', 'shares', 'usage', 'uploads', 'drops'].map((name) => ({ name })),
        components: {
            securitySchemes: {
                bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A person\'s Network user token; a sync key (Bearer ovdl_…) acts for its owner on the drive API only' },
                cookie: { type: 'apiKey', in: 'cookie', name: 'media-hub_at', description: 'The browser session on openvibe.download' },
            },
            schemas: {
                File: { type: 'object', required: ['id', 'name', 'size', 'content_type'], properties: {
                    id: str(), name: str(), size: integer(), content_type: str(), sha256: nullable('string'), folder_id: nullable('string'),
                    created_at: str(), object: { type: 'object', properties: { media_object_id: nullable('string') } },
                } },
                Folder: { type: 'object', required: ['id', 'name'], properties: {
                    id: str(), name: str(), parent_id: nullable('string'), created_at: str(),
                } },
                Share: { type: 'object', required: ['slug', 'state'], properties: {
                    slug: str(), url: str(), file_id: nullable('string'), folder_id: nullable('string'), expires_at: nullable('string'),
                    downloads: integer(), report_count: integer(), state: str(), revoked_at: nullable('string'), suspended_at: nullable('string'),
                    created_at: str(), allowed: arrayOf(str()), limited: { type: 'boolean' }, public: { type: 'boolean' },
                } },
                Usage: { type: 'object', properties: {
                    bytes_used: integer(), bytes_limit: integer(), max_file_bytes: integer(),
                    files: integer(), uploads_today: integer(), uploads_per_day: integer(),
                    live_shares: integer(), max_shares: integer(),
                } },
            },
        },
        paths: { ...Object.fromEntries(Object.entries(PATHS).sort(([a], [b]) => a.localeCompare(b)).map(([p, item]) => [MOUNT + p, item])) },
    };
}

/** The documented routes as "METHOD /api/v1/path": what the app must mount. */
function routes() {
    return Object.entries(PATHS).flatMap(([p, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${MOUNT}${p}`)).sort();
}

/**
 * Serve GET /openapi.json here, one document per request: the request's own origin first, then the
 * other configured hosts. GET /api/v1/openapi.json redirects to it (308).
 */
function mount(app, { hosts = DEFAULT_SERVERS } = {}) {
    const send = (req, res) => {
        const requestOrigin = `${req.protocol}://${req.get('host')}`;
        const requestHost = String(req.hostname || '').toLowerCase();
        const others = hosts.filter((u) => { try { return new URL(u).hostname.toLowerCase() !== requestHost; } catch { return true; } });
        const document = openapi({ servers: [requestOrigin, ...others] });
        res.set('Cache-Control', 'public, max-age=300');
        res.type('application/json; charset=utf-8').send(JSON.stringify(document));
    };
    app.get('/openapi.json', send);
    app.get('/api/v1/openapi.json', (_req, res) => res.redirect(308, '/openapi.json'));
}

module.exports = { openapi, routes, mount, MOUNT };
