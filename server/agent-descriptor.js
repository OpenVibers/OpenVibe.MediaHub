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
        // What an id in a watch page's address is, and that it never changes meaning (AGT-4). The ids are OpenVibe.Media's:
        // its vods and clips tables number them with a PostgreSQL identity column (migrations/0001_initial.sql).
        stableIds: [
            { kind: 'recording', url: 'https://openvibe.video/v/{id}', id: 'OpenVibe.Media\'s recording id, a positive integer from an identity column: never reused or renumbered, even after the recording is deleted', gone: 'a deleted, private or missing recording answers 404, never another recording' },
            { kind: 'clip', url: 'https://openvibe.video/c/{id}', id: 'OpenVibe.Media\'s clip id, the same kind of integer: never reused or renumbered', gone: 'a deleted, private or missing clip answers 404, never another clip' },
        ],
    },
};
