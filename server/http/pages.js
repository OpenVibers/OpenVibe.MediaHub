'use strict';

/**
 * Public pages: the home page and the update log. Crawl artifacts (robots.txt, sitemap.xml, llms.txt,
 * llms-full.txt, JSON-LD) are http/discovery.js.
 *
 * Every page works without JavaScript and is server-rendered through openvibe-shared/shell (render/layout.js).
 * The product replaces the home page's sections and adds its own routes here.
 */
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { html, raw } = require('../render/html');
const { send } = require('../render/layout');

const SITE_NAME = 'OpenVibe.MediaHub';
const TAGLINE = 'Your files, shared on your terms.';

function createPageRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => {
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: SITE_NAME,
            accent: TAGLINE,
            lede: `${SITE_NAME} is a new OpenVibe service. This is its skeleton: the platform plumbing below is in place, and the product is what goes on top of it.`,
            actions: signedIn(req)
                ? [{ label: 'Your account', href: '/auth/me' }, { label: 'What shipped', href: '/updates' }]
                : [{ label: 'Sign in with OpenVibe', href: '/auth/login?next=%2F', primary: true }, { label: 'What shipped', href: '/updates' }],
            note: 'Open source (AGPL-3.0). Sign-in is OpenVibe.Network; a person\'s token stays in an httpOnly cookie.',
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
${raw(showcase.features({
                title: 'What is already here',
                lede: 'The parts every OpenVibe service needs, so a new product starts from them instead of rebuilding them.',
                items: [
                    { icon: 'ov:account', title: 'Sign-in with OpenVibe.Network', text: 'OAuth 2 with PKCE (S256), server-side code exchange, httpOnly session cookies, and offline token verification against the Network signing key.' },
                    { icon: 'ov:page', title: 'Server-rendered pages', text: 'The OpenVibe Frame (navbar and footer), the shared theme, one stylesheet, crawl artifacts and JSON-LD. Every page is complete without JavaScript.' },
                    { icon: 'ov:tools', title: 'An API mount and capabilities', text: 'GET /api/v1/ping today; the router, the problem+json errors and the app/person capability guard are wired and waiting for the product\'s routes.' },
                    { icon: 'ov:gauge', title: 'Limits and readiness', text: 'Per-address and per-caller rate limits, /api/health, a truthful /api/ready and Prometheus metrics on loopback.' },
                    { icon: 'ov:db', title: 'PostgreSQL and migrations', text: 'openvibe-sdk/db, migrations/NNNN_*.sql applied at boot, PGlite in development, and a store with an injectable clock.' },
                    { icon: 'ov:deploy', title: 'Deploy files and tests', text: 'nginx and systemd units, an environment template, and a test suite on PGlite with a mock Network, all through npm test.' },
                ],
            }))}
${raw(showcase.steps({
                title: 'How a new service starts',
                items: [
                    { title: 'Generate it', text: 'node scripts/new-service.js replaces the skeleton\'s tokens (service id, name, domain, port, tagline, env prefix) in every file and file name.' },
                    { title: 'Install and run', text: 'npm install, then npm run dev: the service listens on its port with an embedded PGlite database, if no DATABASE_URL is set.' },
                    { title: 'Make it a product', text: 'Add the product\'s tables and migrations, its capabilities, its routes in server/http/api.js and its pages in server/http/pages.js.' },
                    { title: 'Grant and deploy', text: 'Register the service and its capabilities with OpenVibe.Contracts and OpenVibe.Services, then install the unit and the vhost.' },
                ],
            }))}
${raw(showcase.cta({ title: 'Read the API', text: 'GET /api/v1/ping is the whole API today. The rest is what the product adds.', actions: [{ label: 'The API', href: '/api/v1/ping' }, { label: 'What shipped', href: '/updates' }] }))}`,
        });
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'media-hub', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
