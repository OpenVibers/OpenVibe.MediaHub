'use strict';
// What openvibe.video tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public watch pages, the playlist API under
// /api/v1/video, llms.txt and the sitemap, and the network's sign-in. No documentation page, OpenAPI
// document or MCP endpoint is published here, so none is named.
module.exports = {
    id: 'video',
    name: 'OpenVibe.Video',
    purpose: 'Watch videos on the OpenVibe network: public watch pages for OpenVibe.Live\'s stream recordings and clips, browser recordings and uploads with AI captions, chapters and an AI cut, and playlists.',
    home: 'https://openvibe.video',
    site: 'openvibe.video',
    api: '/api/v1/video',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'The public watch pages are not rate-limited by the app; the playlist API is limited to 120 reads a minute and 3,000 an hour per caller',
    },
};
