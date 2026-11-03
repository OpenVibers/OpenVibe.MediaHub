'use strict';
// The Markdown twins of openvibe.pics' public pages (openvibe-shared/agent-layer, SEO-1): the front door and the
// pages the sitemap lists. A twin is the page's own render: the pics router answers in-process for an anonymous
// browser (server/video/agent-pages.js renderIn), so it cannot drift and never carries a signed-in person's view.
// A picture's page has no twin: it is the uploader's, and may be unlisted.
const { renderIn } = require('../video/agent-pages');

const TWIN_PATH_RE = /^\/(?:exif|content-policy|ai-training|terms|privacy|dmca|updates)?$/;

function createAgentPages({ router, host }) {
    async function renderPublicPage(path) {
        const p = String(path || '/').replace(/\/+$/, '') || '/';
        return TWIN_PATH_RE.test(p) ? renderIn(router, host, p, '') : null;
    }
    return { renderPublicPage };
}

module.exports = { createAgentPages, TWIN_PATH_RE };
