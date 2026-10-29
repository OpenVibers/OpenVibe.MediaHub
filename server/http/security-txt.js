'use strict';

/**
 * /.well-known/security.txt (RFC 9116, SEO-30) for every host this service answers for — openvibe.download and its
 * pages, openvibe.video and openvibe.pics. Contact, Expires and Canonical are required; the canonical URL is the
 * host's own, so the same helper serves all three without a hard-coded host.
 */

// The date the file must be refreshed by: one year on, a person re-reads and re-commits it.
const EXPIRES = '2027-10-29T00:00:00.000Z';
const CONTACT = 'mailto:security@openvibe.network';
// Listed only while https://openvibe.network/security answers 200 (checked 2026-10-29).
const POLICY = 'https://openvibe.network/security';

function securityTxt(origin) {
    const site = String(origin).replace(/\/+$/, '');
    return [
        `Contact: ${CONTACT}`,
        `Expires: ${EXPIRES}`,
        'Preferred-Languages: en',
        `Canonical: ${site}/.well-known/security.txt`,
        `Policy: ${POLICY}`,
        '',
    ].join('\n');
}

/** The route itself: text/plain, a day's cache. */
function handler(origin) {
    const body = securityTxt(origin);
    return (_req, res) => res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send(body);
}

module.exports = { securityTxt, handler, EXPIRES, CONTACT, POLICY };
