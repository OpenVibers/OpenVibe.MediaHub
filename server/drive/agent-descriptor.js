'use strict';
// What openvibe.download tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public pages of the private drive (the home page, the
// safety rules and the update log), the JSON API under /api/v1, the OpenAPI 3.1 document at /openapi.json,
// llms.txt and the sitemap. No MCP endpoint is published here, so none is named.
module.exports = {
    id: 'download',
    name: 'OpenVibe.Download',
    purpose: 'A private drive on the OpenVibe network: keep your own files in your account, share them with a link that expires, and back up a folder from your computer.',
    home: 'https://openvibe.download',
    site: 'openvibe.download',
    api: '/api/v1',
    openapi: '/openapi.json',
    policy: {
        auth: ['Network OIDC'],
        rateLimit: 'The public pages are not limited per address; the API answers a signed-in caller and is bounded by the project\'s quotas, published at /limits.json',
    },
};
