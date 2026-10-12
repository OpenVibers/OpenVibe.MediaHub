'use strict';
// deploy/nginx/openvibe.download.conf: openvibe.pics is still parked (302 to openvibe.network).
// openvibe.video is now OpenVibe.Video, served by the same app on the same port, chosen by Host
// header: its apex HTTPS block proxies to 127.0.0.1:4990 exactly like openvibe.download, and its
// HTTP and www blocks redirect to the apex. Each host keeps its own certificate.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', ...'deploy/nginx/openvibe.download.conf'.split('/')), 'utf8');
const blocks = [...conf.matchAll(/(?:^|\n)server \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
const named = (host) => blocks.filter((b) => new RegExp(`server_name [^;]*\\b${host.replace(/\./g, '\\.')}\\b`).test(b));

// openvibe.pics: parked. Its HTTP block and apex/www HTTPS blocks all answer 302 to the network.
{
    const parked = named('openvibe.pics');
    assert.ok(parked.length >= 3, 'openvibe.pics: the HTTP block and the apex and www HTTPS blocks are there');
    for (const b of parked) {
        assert.match(b, /return 302 https:\/\/openvibe\.network\/;/, 'openvibe.pics: redirects to openvibe.network');
        assert.doesNotMatch(b, /proxy_pass/, 'openvibe.pics: proxies nothing');
    }
}

// openvibe.video: no longer parked. Its apex HTTPS block proxies to the app; www and HTTP redirect to apex.
{
    const video = named('openvibe.video');
    assert.ok(video.length >= 3, 'openvibe.video: the HTTP block and the apex and www HTTPS blocks are there');
    const apex = video.find((b) => /listen 443 ssl;/.test(b) && /server_name openvibe\.video;/.test(b));
    const www = video.find((b) => /listen 443 ssl;/.test(b) && /server_name www\.openvibe\.video;/.test(b));
    const http = video.find((b) => /listen 80;/.test(b));
    assert.ok(apex && www && http, 'openvibe.video: apex, www and HTTP blocks are there');
    assert.match(apex, /proxy_pass http:\/\/127\.0\.0\.1:4990;/, 'openvibe.video apex proxies to the app');
    assert.match(www, /return 301 https:\/\/openvibe\.video\$request_uri;/, 'openvibe.video www redirects to apex');
    assert.match(http, /return 301 https:\/\/openvibe\.video\$request_uri;/, 'openvibe.video HTTP redirects to apex');
    assert.doesNotMatch(apex, /return 302 https:\/\/openvibe\.network\/;/, 'openvibe.video apex is no longer parked');
}

// Each host uses its own certificate, on both its apex and its www block.
for (const host of ['openvibe.pics', 'openvibe.video']) {
    for (const b of named(host).filter((x) => /listen 443 ssl;/.test(x))) {
        assert.match(b, new RegExp(`ssl_certificate\\s+/etc/letsencrypt/live/${host.replace(/\./g, '\\.')}/fullchain\\.pem;`), `${host}: its own certificate`);
    }
}

console.log('nginx: pics parked (302 openvibe.network), video proxies to 127.0.0.1:4990, own certificates');
