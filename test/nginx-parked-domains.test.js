'use strict';
// deploy/nginx/openvibe.download.conf: openvibe.video (OpenVibe.Video) and openvibe.pics (OpenVibe.Pics, 2026-10-15) are
// served by the same app on the same port as openvibe.download, chosen by Host header: each apex HTTPS block proxies to
// 127.0.0.1:4990, and each host's HTTP and www blocks redirect to its apex. Nothing is parked any more. Each host keeps
// its own certificate. Pics takes a picture (21 MB) only on its two upload paths; everything else stays at 128 KB.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const conf = fs.readFileSync(path.join(__dirname, '..', ...'deploy/nginx/openvibe.download.conf'.split('/')), 'utf8');
const blocks = [...conf.matchAll(/(?:^|\n)server \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
const named = (host) => blocks.filter((b) => new RegExp(`server_name [^;]*\\b${host.replace(/\./g, '\\.')}\\b`).test(b));
const esc = (host) => host.replace(/\./g, '\\.');

for (const host of ['openvibe.video', 'openvibe.pics']) {
    const all = named(host);
    assert.ok(all.length >= 3, `${host}: the HTTP block and the apex and www HTTPS blocks are there`);
    const apex = all.find((b) => /listen 443 ssl;/.test(b) && new RegExp(`server_name ${esc(host)};`).test(b));
    const www = all.find((b) => /listen 443 ssl;/.test(b) && new RegExp(`server_name www\\.${esc(host)};`).test(b));
    const plain = all.find((b) => /listen 80;/.test(b));
    assert.ok(apex && www && plain, `${host}: apex, www and HTTP blocks are there`);
    assert.match(apex, /proxy_pass http:\/\/127\.0\.0\.1:4990;/, `${host} apex proxies to the app`);
    assert.match(www, new RegExp(`return 301 https://${esc(host)}\\$request_uri;`), `${host} www redirects to apex`);
    assert.match(plain, new RegExp(`return 301 https://${esc(host)}\\$request_uri;`), `${host} HTTP redirects to apex`);
    assert.doesNotMatch(apex, /return 302 https:\/\/openvibe\.network\/;/, `${host} apex is not parked`);
    assert.match(apex, /location ~\* \^\/internal\(\/\|\$\) \{ return 404; \}/, `${host}: /internal is not proxied`);
    for (const b of all.filter((x) => /listen 443 ssl;/.test(x))) {
        assert.match(b, new RegExp(`ssl_certificate\\s+/etc/letsencrypt/live/${esc(host)}/fullchain\\.pem;`), `${host}: its own certificate`);
    }
}

// openvibe.pics: a picture only where one is uploaded.
{
    const apex = named('openvibe.pics').find((b) => /server_name openvibe\.pics;/.test(b));
    assert.match(apex, /\n    client_max_body_size 128k;/, 'pics: 128 KB by default');
    for (const loc of ['= /api/v1/images', '= /upload']) {
        const m = new RegExp(`location ${loc.replace(/[/.]/g, '\\$&')} \\{([\\s\\S]*?)\\n    \\}`).exec(apex);
        assert.ok(m, `pics: location ${loc}`);
        assert.match(m[1], /client_max_body_size 21m;/, `pics: ${loc} takes a 20 MB picture`);
        assert.match(m[1], /limit_req zone=media-hub_writes/, `pics: ${loc} is rate-limited`);
    }
}

console.log('nginx: video and pics proxy to 127.0.0.1:4990 with their own certificates; pics takes pictures only on its upload paths');
