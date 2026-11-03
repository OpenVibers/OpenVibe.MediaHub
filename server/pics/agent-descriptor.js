'use strict';
// What openvibe.pics tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json (SEO-2).
// Every field is something the Pics host really serves; the purpose is its own llms.txt summary.
module.exports = {
    id: 'pics',
    name: 'OpenVibe.Pics',
    purpose: 'Picture hosting on the OpenVibe network: upload a picture, get a link to share or embed, albums, any size or format. Pictures are unlisted and re-encoded with their metadata removed.',
    home: 'https://openvibe.pics',
    site: 'openvibe.pics',
    openapi: '/openapi.json',
    policy: {
        auth: ['none', 'Network OIDC'],
    },
};
