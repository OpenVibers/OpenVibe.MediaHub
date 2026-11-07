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
        // What an id in a watch page's address is, and that it never changes meaning (AGT-4). A page is addressed by
        // its watch id, minted once by OpenVibe.Media for a recording or a clip (and copied onto an upload), never by
        // the number behind it; the numbered addresses (/v/{id}, /c/{id}, /u/{id}) answer 301 to the watch page.
        stableIds: [
            { kind: 'recording', url: 'https://openvibe.video/watch?v={id}', id: 'OpenVibe.Media\'s watch id for the recording, 11 characters of URL-safe base64, never reused and never derived from the number behind it', gone: 'a deleted, private or missing recording answers 404, never another recording' },
            { kind: 'clip', url: 'https://openvibe.video/watch?v={id}', id: 'OpenVibe.Media\'s watch id for the clip, the same kind of id as a recording\'s, never reused', gone: 'a deleted, private or missing clip answers 404, never another clip' },
            { kind: 'upload', url: 'https://openvibe.video/watch?v={id}', id: 'OpenVibe.Video\'s watch id for an upload or a browser recording, 11 characters of URL-safe base64, never reused', gone: 'a deleted, private or missing upload answers 404, never another video' },
        ],
    },
};
