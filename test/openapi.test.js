'use strict';
/**
 * /openapi.json documents this service's drive API, and the document is the API: every route it lists
 * is a route the app mounts, and every mounted /api/v1 route is listed (the probes and the
 * /api/v1/openapi.json redirect excepted). The mounted set is read from the real Express stack, so a
 * route added, renamed or removed without the document fails here.
 *
 * The document is per request: `servers` starts with the host the request came in on, then the other
 * hosts this service answers for.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { routes, MOUNT } = require('../server/http/openapi');

/** The path an app.use(...) layer mounts its router at, decoded from Express's compiled regexp. */
function mountOf(layer) {
    const source = String((layer.regexp && layer.regexp.source) || '');
    if (layer.regexp && layer.regexp.fast_slash) return '';
    const m = /^\^(.*?)\\\/\?\(\?=\\\/\|\$\)$/.exec(source);
    assert.ok(m, `cannot read the mount path of a router layer (${source})`);
    return m[1].replace(/\\\//g, '/').replace(/\\\./g, '.');
}

/** ":param" as OpenAPI writes it, "{param}". */
const templated = (p) => String(p).replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

/** Every "METHOD /path" the app answers, routers included. */
function mounted(app) {
    const out = new Set();
    const walk = (stack, prefix) => {
        for (const layer of stack) {
            if (layer.route) {
                for (const [method, on] of Object.entries(layer.route.methods)) {
                    if (!on || method === '_all') continue;
                    for (const p of [].concat(layer.route.path)) out.add(`${method.toUpperCase()} ${prefix}${templated(p)}`);
                }
            } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
                walk(layer.handle.stack, prefix + mountOf(layer));
            }
        }
    };
    assert.ok(app._router && app._router.stack, 'the app has a router');
    walk(app._router.stack, '');
    return out;
}

const LEFT_OUT = new Set(['GET /api/health', 'GET /api/ready', 'GET /api/v1/openapi.json']);

(async () => {
    const t = await boot();
    try {
        let doc = null;
        await check('/openapi.json is served as cached JSON, with this host first', async () => {
            const r = await t.get('/openapi.json');
            assert.strictEqual(r.status, 200);
            assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
            assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=300');
            doc = r.json();
            assert.strictEqual(doc.openapi, '3.1.0');
            assert.ok(doc.paths && typeof doc.paths === 'object');
            assert.ok(Object.keys(doc.paths).length > 0, 'paths is not empty');
            assert.strictEqual(doc.info.title, 'OpenVibe.MediaHub API');
            assert.ok(doc.servers.length >= 3, 'the other hosts are listed');
            assert.ok(doc.servers[0].url.includes('127.0.0.1'), `the request host is first (${doc.servers[0].url})`);
            const hosts = doc.servers.map((s) => new URL(s.url).hostname);
            for (const host of ['openvibe.download', 'openvibe.video', 'openvibe.pics']) assert.ok(hosts.includes(host), `${host} is listed`);
        });

        await check('every documented route is mounted, with an operationId and responses', async () => {
            const live = new Set(mounted(t.app));
            for (const [p, item] of Object.entries(doc.paths)) {
                assert.ok(p.startsWith('/api/'), `${p} is outside /api`);
                for (const [method, op] of Object.entries(item)) {
                    assert.ok(op.operationId, `${method.toUpperCase()} ${p} has an operationId`);
                    assert.ok(op.responses && Object.keys(op.responses).length, `${method.toUpperCase()} ${p} describes its responses`);
                    assert.ok(live.has(`${method.toUpperCase()} ${p}`), `${method.toUpperCase()} ${p} is documented but not mounted`);
                }
            }
        });

        await check('every mounted /api/v1 route is documented', async () => {
            const documented = Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${p}`)).sort();
            const live = [...mounted(t.app)].filter((key) => key.split(' ')[1].startsWith(`${MOUNT}/`) && !LEFT_OUT.has(key)).sort();
            assert.deepStrictEqual(live, documented);
            assert.deepStrictEqual(documented, routes(), 'server/http/openapi.js routes() and the document agree');
        });

        await check('the document follows the Host header', async () => {
            const u = new URL(t.base);
            const text = await new Promise((resolve, reject) => {
                const req = http.get({ hostname: u.hostname, port: u.port, path: '/openapi.json', headers: { host: 'openvibe.video' } }, (res) => {
                    const chunks = [];
                    res.on('data', (c) => chunks.push(c));
                    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
                });
                req.on('error', reject);
            });
            const hosts = JSON.parse(text).servers.map((s) => new URL(s.url).hostname);
            assert.strictEqual(hosts[0], 'openvibe.video');
            assert.ok(!hosts.slice(1).includes('openvibe.video'), 'the request host is not repeated');
        });

        await check('/api/v1/openapi.json redirects to it', async () => {
            const r = await fetch(`${t.base}/api/v1/openapi.json`, { redirect: 'manual' });
            assert.strictEqual(r.status, 308);
            assert.strictEqual(r.headers.get('location'), '/openapi.json');
        });
    } finally {
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exitCode = 1; });
