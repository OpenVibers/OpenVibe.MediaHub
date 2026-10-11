'use strict';
/** The Media client gets one Network service token and never calls Media without it. */
const assert = require('assert');
const { load } = require('../server/config');
const { createMediaClient } = require('../server/media/client');

async function main() {
    const requests = [];
    const fetchImpl = async (url, options) => {
        requests.push({ url, options });
        if (url.endsWith('/oauth/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'svc-media', token_type: 'Bearer', expires_in: 300 }) };
        return { ok: true, status: 200, json: async () => ({ id: 'med_test' }) };
    };
    const config = load({
        OV_NETWORK_INTERNAL_URL: 'http://network.test', OV_OAUTH_CLIENT_ID: 'media-hub',
        OV_OAUTH_CLIENT_SECRET: 'test-secret', MEDIAHUB_MEDIA_URL: 'http://media.test',
    });
    const client = createMediaClient({ config, fetchImpl });
    assert.strictEqual(client.enabled, true);
    assert.strictEqual(requests.length, 0, 'token client is lazy');
    assert.strictEqual((await client.get('med_first')).ok, true);
    assert.strictEqual((await client.get('med_second')).ok, true);
    assert.strictEqual(requests.length, 3, 'one cached token for two Media requests');
    const tokenRequest = requests[0];
    assert.strictEqual(tokenRequest.url, 'http://network.test/oauth/token');
    assert.strictEqual(tokenRequest.options.method, 'POST');
    const form = new URLSearchParams(tokenRequest.options.body);
    assert.strictEqual(form.get('grant_type'), 'client_credentials');
    assert.strictEqual(form.get('audience'), 'openvibe.media');
    assert.strictEqual(form.get('client_id'), 'media-hub');
    assert.strictEqual(form.get('client_secret'), 'test-secret');
    assert.ok(requests.slice(1).every((request) => request.options.headers.Authorization === 'Bearer svc-media'));

    const missing = createMediaClient({ config: load({ OV_OAUTH_CLIENT_SECRET: '' }), fetchImpl });
    assert.strictEqual(missing.enabled, false);
    assert.deepStrictEqual(await missing.get('med_test'), {
        ok: false, status: 503, code: 'media.not_configured', detail: 'OV_OAUTH_CLIENT_SECRET is not set',
    });
    assert.strictEqual(requests.length, 3, 'an unconfigured client makes no request');

    const failing = createMediaClient({ config, fetchImpl: async () => { throw new Error('secret must stay private'); }, log: { warn() {} } });
    const refused = await failing.get('med_test');
    assert.strictEqual(refused.status, 502);
    assert.strictEqual(refused.code, 'media.unreachable');
    assert.ok(!refused.detail.includes('secret'));
}

main().then(() => console.log('media client passed'), (err) => { console.error(err); process.exitCode = 1; });
