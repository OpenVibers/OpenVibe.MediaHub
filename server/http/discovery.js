'use strict';

/**
 * Crawl artifacts for openvibe.download, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in and
 * the API are not.
 *
 * The product extends PAGE_TEXT and publicPages() with its own pages; the routes and headers here stay.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.MediaHub';
const DESCRIPTION = 'OpenVibe.MediaHub — Your files, shared on your terms.';
// /s/ (with the slash) rather than /s, or the rule would also swallow /safety, which is a public page.
const DISALLOW = ['/auth/', '/api/', '/files', '/s/', '/staff'];

const PAGE_TEXT = {
    '/': ['OpenVibe.MediaHub home', 'OpenVibe.MediaHub: Your files, shared on your terms. A private drive for a signed-in OpenVibe account, with share links that expire, can be revoked and need the downloader to be signed in too.'],
    '/safety': ['Safety rules', 'What OpenVibe.Download allows and does not, who can upload and download, how reports work, and who to write to about abuse or copyright.'],
    '/updates': ['What shipped on OpenVibe.MediaHub', 'This site\'s update log, from the network changelog feed.'],
};

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'openvibe' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/**
 * The pages a crawler may read: the home page, the safety rules and the update log — nothing behind sign-in.
 * /files, /s/… and /staff are a person's own, so they are disallowed above and left out here.
 */
const publicPages = () => [
    { path: '/', changefreq: 'weekly', priority: 1.0 },
    { path: '/safety', changefreq: 'monthly', priority: 0.6 },
    { path: '/updates', changefreq: 'daily', priority: 0.5 },
];

function createDiscoveryRoutes(ctx) {
    const { config } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.download: the public pages are for search and AI crawlers; sign-in and the API are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.MediaHub: Your files, shared on your terms.',
            details: 'Every page is server-rendered and readable without JavaScript.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.MediaHub', url: abs('/'), note: 'Your files, shared on your terms.' },
                    { title: 'Safety rules', url: abs('/safety'), note: 'what is allowed, how reports work, who to write to' },
                    { title: 'What shipped on OpenVibe.MediaHub', url: abs('/updates') },
                ] },
                { title: 'Machine-readable', links: [
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const pages = publicPages().map((p) => ({ url: p.path, title: PAGE_TEXT[p.path][0], text: PAGE_TEXT[p.path][1] }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.MediaHub, one line each.',
            base: site,
            maxBytes: 64 * 1024,
            sections: [{ title: 'Pages', pages }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = publicPages().map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
