'use strict';

/**
 * One process, three brand surfaces (the media-hub product manifest: openvibe.download, openvibe.pics and
 * openvibe.video). The host decides which one a request is for — there is no separate deploy, and no cookie or
 * query parameter can move a request from one brand to another.
 *
 * v1 launches openvibe.download only, as a private drive. On openvibe.pics and openvibe.video the service answers
 * an honest "coming" page and nothing else: no drive, no share links, no API and no uploads, because neither brand
 * has the safety tooling its content needs yet (there is no malware or CSAM scanning on the network).
 *
 * The brand is read from the Host header nginx passes through (req.hostname; TRUST_PROXY lets a proxy name it with
 * X-Forwarded-Host). An unknown host — a bare address in development, an internal health check — is the download
 * brand, so the deployed apex never behaves differently from a test.
 */
const BRANDS = {
    'openvibe.download': 'download',
    'openvibe.pics': 'pics',
    'openvibe.video': 'video',
};

// What each unlaunched brand's page says: the product's own words, kept here so the page and the report agree.
const COMING = {
    pics: {
        domain: 'openvibe.pics',
        name: 'OpenVibe.Pics',
        tagline: 'Share pictures. Fast, open, yours.',
        what: 'OpenVibe.Pics will be the picture home of the OpenVibe network: quick uploads and share links, albums and galleries, image processing and optimisation served from a shared CDN, and AI image tools — an open and modular alternative to Imgur, usable through the OpenVibe API too.',
        pillars: ['Upload & share', 'Albums & galleries', 'Processing', 'AI image tools'],
    },
    video: {
        domain: 'openvibe.video',
        name: 'OpenVibe.Video',
        tagline: 'Your videos, everywhere.',
        what: 'OpenVibe.Video will be the home of long-form video on the OpenVibe network: watch pages, channels and playlists for uploads and past streams, a creator tool that publishes one upload to many platforms, and AI captions, highlights and editing — delivered by OpenVibe.Media.',
        pillars: ['Watch', 'Publish everywhere', 'AI tools', 'From your streams'],
    },
};

/** The brand a request is for. Anything unrecognised is the launched one. */
function brandOf(req) {
    const host = String((req && req.hostname) || '').toLowerCase().replace(/^www\./, '');
    return BRANDS[host] || 'download';
}

/** Set req.brand for every request, before anything reads it (the API and the pages both do). */
function middleware() {
    return (req, _res, next) => { req.brand = brandOf(req); next(); };
}

module.exports = { brandOf, middleware, BRANDS, COMING };
