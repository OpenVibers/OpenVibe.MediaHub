'use strict';
// deploy/nginx/openvibe.download.conf: openvibe.pics and openvibe.video are parked. Their server blocks (HTTP and
// HTTPS, apex and www) answer 302 to openvibe.network and proxy nothing — no request for either host reaches the
// app, which is why the app has no "coming" pages for them. Each name keeps its own certificate.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', ...'deploy/nginx/openvibe.download.conf'.split('/')), 'utf8');
const blocks = [...conf.matchAll(/(?:^|\n)server \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
const named = (host) => blocks.filter((b) => new RegExp(`server_name [^;]*\\b${host.replace(/\./g, '\\.')}\\b`).test(b));

for (const host of ['openvibe.pics', 'openvibe.video']) {
    const parked = named(host);
    assert.ok(parked.length >= 3, `${host}: the HTTP block and the apex and www HTTPS blocks are there`);
    for (const b of parked) {
        assert.match(b, /return 302 https:\/\/openvibe\.network\/;/, `${host}: redirects to openvibe.network`);
        assert.doesNotMatch(b, /proxy_pass/, `${host}: proxies nothing`);
    }
}

// Each host uses its own certificate, on both its apex and its www block.
for (const host of ['openvibe.pics', 'openvibe.video']) {
    for (const b of named(host).filter((x) => /listen 443 ssl;/.test(x))) {
        assert.match(b, new RegExp(`ssl_certificate\\s+/etc/letsencrypt/live/${host.replace(/\./g, '\\.')}/fullchain\\.pem;`), `${host}: its own certificate`);
    }
}

console.log('nginx parked domains: pics and video answer 302 openvibe.network, no proxy_pass, own certificates');
