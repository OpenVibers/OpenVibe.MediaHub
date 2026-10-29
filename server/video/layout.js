'use strict';

/**
 * The OpenVibe.Video page shell. Same composition as the drive's layout (openvibe-shared/shell,
 * the OpenVibe Frame navbar and footer, the shared app icon), but public and read-only: no drive
 * navigation, and every canonical URL is on the video host. The brand here is OpenVibe.Video.
 *
 * A page rendered for a signed-in person names them (and a session cookie is present), so it is
 * private and never cached; every other page stays public. Cloudflare ignores Vary, so the cache
 * decision is made from the session cookie's presence rather than Vary.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const appIcon = require('openvibe-shared/app-icon');
const ovServe = require('openvibe-shared/serve');
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const seo = require('openvibe-shared/seo');
const { html, raw, esc, render } = require('../render/html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Video';
const TAGLINE = 'Upload, record and watch, with AI captions and chapters';
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

const hashes = new Map();
function assetVersion(rel) {
    if (hashes.has(rel)) return hashes.get(rel);
    let v = 'dev';
    try { v = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC_DIR, rel))).digest('hex').slice(0, 10); } catch { /* missing asset */ }
    hashes.set(rel, v);
    return v;
}
const asset = (rel) => `/${rel}?v=${assetVersion(rel)}`;

// The pages with a Markdown twin (openvibe-shared/agent-layer): the home and the watch pages of a
// recording and a clip. The others (search, categories, an account's playlists) have none.
const TWIN_PATH_RE = /^\/(?:v|c)\/\d+$/;
function hasTwin(path) {
    const p = String(path || '/').split('?')[0].replace(/\/+$/, '') || '/';
    return p === '/' || TWIN_PATH_RE.test(p);
}

/** o: title, description, body (html), config, path, index, noindex, viewer, private, crumbs [{label, href}], scripts [rel],
 *     player (true: the network's video player, openvibe-shared player.js/css, on video[data-ov-player]),
 *     jsonLd (structured data for the page), image (its share image, an https URL), ogType */
function renderPage(o) {
    // The front page's title says what the site is (search results show it; at most 60 characters).
    const title = o.title || (o.path === '/' ? `${SITE_NAME}: upload, record and watch, with AI captions` : SITE_NAME);
    const viewer = o.viewer || { kind: 'anonymous' };
    const signedIn = viewer.kind === 'user';
    const pathNow = o.path || '/';
    const canonical = `${String(o.baseUrl).replace(/\/+$/, '')}${pathNow.split('?')[0]}`;
    const crumbs = (o.crumbs || []).length
        ? html`<nav class="crumbs" aria-label="Breadcrumbs">${o.crumbs.map((c, i) => html`${i ? ' / ' : ''}${c.href ? html`<a href="${c.href}">${c.label}</a>` : c.label}`)}</nav>`
        : '';
    const head = `<meta name="referrer" content="strict-origin-when-cross-origin">
${appIcon.headTags({ site: 'media-hub' })}
<link rel="stylesheet" href="${asset('css/app.css')}">
<link rel="stylesheet" href="${asset('css/video.css')}">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer">
${o.player ? `<link rel="stylesheet" href="${ovServe.url('player.css')}">\n<script src="${ovServe.url('player.js')}" defer></script>\n` : ''}${(o.scripts || []).map((rel) => `<script src="${asset(rel)}" defer></script>`).join('\n')}`;
    const account = signedIn
        ? html`Signed in as <strong>${viewer.displayName || viewer.username || 'you'}</strong> · <a href="/auth/logout?next=${encodeURIComponent(pathNow)}">Sign out</a>`
        : html`<a href="/auth/login?next=${encodeURIComponent(pathNow)}">Sign in with OpenVibe</a>`;
    const body = `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
<noscript><div class="account-bar" role="navigation" aria-label="Account">${render(account)}</div></noscript>
<main id="main" class="page ovv-page">
${render(crumbs)}
${render(o.body)}
</main>`;
    return shell.page({
        name: SITE_NAME,
        lang: 'en',
        title,
        titleSuffix: o.title ? ` · ${SITE_NAME}` : '',
        siteName: SITE_NAME,
        description: o.description || `${SITE_NAME} — ${TAGLINE}`,
        canonical,
        robots: o.noindex ? 'noindex' : (o.index ? 'index, follow' : 'noindex, nofollow'),
        ...(o.jsonLd ? { jsonLd: o.jsonLd } : {}),
        ...(o.image ? { image: o.image, imageAlt: title } : {}),
        ...(o.ogType ? { type: o.ogType } : {}),
        home: '/',
        // The pages with a twin name it, so a reader (or an agent) finds the Markdown of this page.
        agentLayer: hasTwin(pathNow),
        llms: '/llms.txt',
        navLinks: NAV_LINKS,
        navbar: {
            service: 'media-hub',
            apiBase: NETWORK_URL,
            links: NAV_LINKS.filter((l) => !l.noscriptOnly).map(({ noscriptOnly, ...l }) => ({ ...l, active: l.href === '/' ? o.path === '/' : String(o.path || '').startsWith(l.href) })),
            appBar: true,   // phones: the places with icons as the bottom tab bar (Shared 4.20)
            search: { page: '/search', label: 'OpenVibe.Video' },
            history: { type: 'page', title },
            sessionUrl: '/auth/me',
            loginUrl: '/auth/login?next={path}',
            logoutUrl: '/auth/logout?next={path}',
            silentLogin: `${String(o.baseUrl).replace(/\/+$/, '')}/auth/login?silent=1&next={url}`,
        },
        // The full footer (the network's sites, its legal links), as every browse page has (owner, 2026-10-27: "where are
        // all those cool SEO links that … interconnect all our platforms"); the quiet line only where someone is mid-task.
        footer: { service: 'media-hub', variant: /^\/(upload|record)(\/|$)/.test(String(o.path || '')) ? 'compact' : 'full', brandName: SITE_NAME, updates: '/updates' },
        head,
        body,
    });
}

// The site's own places in the navbar: the videos, and your playlists (signed in; the page asks you to sign in).
// The places: the main ones carry an icon (phones get them as the bottom tab bar), Playlists folds into the navbar's More
// (Shared 4.22). Search is the navbar's magnifier, which offers this site's own search first; the page without
// JavaScript keeps its Search link.
const NAV_LINKS = [
    { label: 'Videos', href: '/', icon: 'fa-play' },
    { label: 'Search', href: '/search', icon: 'fa-magnifying-glass', noscriptOnly: true },
    { label: 'Upload', href: '/upload', icon: 'fa-upload' },
    { label: 'Record', href: '/record', icon: 'fa-video' },
    { label: 'Your videos', href: '/me/videos', icon: 'fa-photo-film' },
    { label: 'Playlists', href: '/playlists', icon: 'fa-list-check', more: true },
];

// A signed-out copy is never reused without asking: Cloudflare drops `Vary` (it keeps only Accept-Encoding), so a
// browser keyed the guest copy by its URL alone and, for five minutes after a quiet sign-in, showed the signed-out page
// (no owner tools, "Sign in to save"; 2026-10-22). Cloudflare does not cache these pages (DYNAMIC), so nothing is lost.
const GUEST_HTML = 'public, max-age=0, must-revalidate';
/** Send a video page. Signed-out pages are public but always revalidated; a session cookie makes a page private, no-store. */
function send(res, status, o) {
    if (!res.get('Cache-Control')) res.set('Cache-Control', o.cache || (o.private ? cache.htmlHeaders({ private: true }) : GUEST_HTML));
    res.set('Vary', 'Host');
    // A page with a twin names it in the Link header, the same way the twin names the page.
    if (hasTwin(o.path)) {
        const canonical = `${String(o.baseUrl).replace(/\/+$/, '')}${String(o.path || '/').split('?')[0]}`;
        res.set('Link', seo.linkHeaderTags(canonical, '/llms.txt').header);
    }
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, SITE_NAME, TAGLINE, raw, html };
