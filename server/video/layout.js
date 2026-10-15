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
const shell = require('openvibe-shared/shell');
const cache = require('openvibe-shared/cache-policy');
const { html, raw, esc, render } = require('../render/html');

const NETWORK_URL = 'https://openvibe.network';
const SITE_NAME = 'OpenVibe.Video';
const TAGLINE = 'Stream recordings and clips from OpenVibe.Live';
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

/** o: title, description, body (html), config, path, index, noindex, viewer, private, crumbs [{label, href}], scripts [rel],
 *     jsonLd (structured data for the page), image (its share image, an https URL), ogType */
function renderPage(o) {
    // The front page's title says what the site is (search results show it; at most 60 characters).
    const title = o.title || (o.path === '/' ? `${SITE_NAME}: recordings and clips from OpenVibe.Live` : SITE_NAME);
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
${(o.scripts || []).map((rel) => `<script src="${asset(rel)}" defer></script>`).join('\n')}`;
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
        navLinks: NAV_LINKS,
        navbar: {
            service: 'media-hub',
            apiBase: NETWORK_URL,
            links: NAV_LINKS.map((l) => ({ ...l, active: l.href === '/' ? o.path === '/' : String(o.path || '').startsWith(l.href) })),
            history: { type: 'page', title },
            sessionUrl: '/auth/me',
            loginUrl: '/auth/login?next={path}',
            logoutUrl: '/auth/logout?next={path}',
            silentLogin: `${String(o.baseUrl).replace(/\/+$/, '')}/auth/login?silent=1&next={url}`,
        },
        footer: { service: 'media-hub', variant: 'compact', brandName: SITE_NAME, updates: '/updates' },
        head,
        body,
    });
}

// The site's own places in the navbar: the videos, and your playlists (signed in; the page asks you to sign in).
const NAV_LINKS = [{ label: 'Videos', href: '/' }, { label: 'Playlists', href: '/playlists' }];

/** Send a video page. Signed-out pages are public; a session cookie makes a page private, no-store. */
function send(res, status, o) {
    if (!res.get('Cache-Control')) res.set('Cache-Control', o.cache || cache.htmlHeaders({ private: o.private, maxAge: 300 }));
    res.set('Vary', 'Host');
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, SITE_NAME, TAGLINE, raw, html };
