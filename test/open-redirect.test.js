'use strict';
// Open redirect regression (WS-R task 5): the sign-in "next" never leaves the site. Browsers drop tab and
// newline characters from a URL and read a backslash as "/", so "/<TAB>/evil.com" is "//evil.com" to them;
// until 2026-09-26 it got through here.
const assert = require('assert');
const { sanitizeNext } = require('../server/auth/sso');

const config = { baseUrl: 'https://site.openvibe.test', networkUrl: 'https://openvibe.network' };
const home = (v) => {
    const out = String(sanitizeNext(v, config));
    const host = new URL(out.replace(/[\t\n\r]/g, ''), 'https://site.openvibe.test').host;
    return host === 'site.openvibe.test' || host === 'openvibe.network';
};
for (const v of ['//evil.com', '/\\evil.com', '\\\\evil.com', 'https://evil.com', 'http:evil.com', '/\t/evil.com', '/\n/evil.com', '\t//evil.com',
    ' //evil.com', '/\\/evil.com', 'https:/\\evil.com', '///evil.com', 'javascript:alert(1)', '/%09/evil.com']) {
    assert.ok(home(v), `${JSON.stringify(v)} stays on the site (got ${JSON.stringify(sanitizeNext(v, config))})`);
    assert.ok(!/^\s*javascript:/i.test(String(sanitizeNext(v, config))), JSON.stringify(v));
}
assert.strictEqual(sanitizeNext('/settings?tab=a', config), '/settings?tab=a', 'a plain relative path is kept');

// The shared navbar's silent sign-in sends the whole page address: on one of this service's own origins it is that
// page's path (before 2026-10-22 it went to the home page); anywhere else, or a lookalike host, goes home.
const hub = { baseUrl: 'https://openvibe.download', video: { url: 'https://openvibe.video' }, pics: { url: 'https://openvibe.pics' } };
assert.strictEqual(sanitizeNext('https://openvibe.video/v/5902', hub), '/v/5902');
assert.strictEqual(sanitizeNext('https://openvibe.video/v/5890?t=6528#c', hub), '/v/5890?t=6528#c');
assert.strictEqual(sanitizeNext('https://openvibe.pics/a/abc', hub), '/a/abc');
assert.strictEqual(sanitizeNext('https://openvibe.download/files', hub), '/files');
for (const v of ['https://evil.com/v/1', 'https://openvibe.video.evil.com/v/1', 'https://openvibe.video@evil.com/', 'https://openvibe.video//evil.com', 'http://openvibe.video/v/1', 'https://openvibe.video/\\evil.com']) {
    assert.strictEqual(sanitizeNext(v, hub), '/', v);
}
assert.strictEqual(sanitizeNext('https://openvibe.video/v/1'), '/', 'with no origins known, an absolute URL goes home');
console.log('open redirect: all checks passed');
