'use strict';

/**
 * The OpenVibe.Video page shell. Same composition as the drive's layout (openvibe-shared/shell,
 * the OpenVibe Frame navbar and footer, the shared app icon), but public and read-only: no sign-in
 * bar, no drive navigation, and every canonical URL is on the video host. The brand here is
 * OpenVibe.Video.
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

/** o: title, description, body (html), config, path, index, noindex, crumbs [{label, href}], scripts [rel] */
function renderPage(o) {
    const title = o.title || SITE_NAME;
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
    const body = `<a class="skip" href="#main">Skip to content</a>
<div id="navbar-mount"></div>
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
        home: '/',
        navLinks: [],
        navbar: { service: 'media-hub', apiBase: NETWORK_URL, history: { type: 'page', title } },
        footer: { service: 'media-hub', variant: 'compact', brandName: SITE_NAME },
        head,
        body,
    });
}

/** Send a video page. Video pages are public; unlisted pages are noindex but still cached. */
function send(res, status, o) {
    if (!res.get('Cache-Control')) res.set('Cache-Control', o.cache || cache.htmlHeaders({ maxAge: 300 }));
    res.set('Vary', 'Host');
    res.status(status).type('html').send(renderPage(o));
}

module.exports = { renderPage, send, asset, assetVersion, SITE_NAME, TAGLINE, raw, html };
