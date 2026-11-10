'use strict';
// The watch page's player takes the picture's shape once it plays (public/js/video.js followShape, public/css/video.css):
// an upright recording opens into an upright box, one that turns mid-stream (OpenVibe.Media cuts one part per shape since
// 2026-10-26; VOD 6017 played its portrait part squeezed into 16:9) eases between its parts' shapes, a lowered resolution
// moves nothing, and nothing changes before playback starts (loading the page shifts nothing below the player).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'video.js'), 'utf8');
const m = /function followShape\(video\) \{[\s\S]*?\n {4}\}\n/.exec(src);
assert.ok(m, 'followShape() is in video.js');
const ctx = { Math };
vm.createContext(ctx);
vm.runInContext(`${m[0]}; this.followShape = followShape;`, ctx);

const listeners = {};
const vars = {};
const video = {
    videoWidth: 0, videoHeight: 0, getAttribute: () => null,
    style: { setProperty: (k, v) => { vars[k] = v; } },
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
};
const fire = (t) => (listeners[t] || []).forEach((f) => f());
const show = (w, h) => { video.videoWidth = w; video.videoHeight = h; fire('resize'); };
ctx.followShape(video);

show(1280, 720);
assert.strictEqual(vars['--ovv-ar'], undefined, 'before playback the box stays 16:9 (no shift on load)');
fire('playing');
assert.strictEqual(vars['--ovv-ar'], '1.7778');
show(720, 1280);
assert.strictEqual(vars['--ovv-ar'], '0.5625', 'the recording turns: the box turns with it');
for (const [w, h] of [[540, 960], [360, 640], [358, 640]]) { show(w, h); assert.strictEqual(vars['--ovv-ar'], '0.5625', `${w}x${h} keeps the box`); }
show(960, 720);
assert.strictEqual(vars['--ovv-ar'], '1.3333');
show(8000, 100);
assert.strictEqual(vars['--ovv-ar'], '3.2000', 'a broken size is held to 32:10');

// The page already knows the shape (pages.js startAspect, from Live's stream history; owner, 2026-10-27: an upright
// phone recording opened in a 16:9 box): the box is upright from the first paint and the matching file moves nothing.
{
    const l2 = {};
    const v2 = {};
    const known = {
        videoWidth: 0, videoHeight: 0, getAttribute: (k) => (k === 'data-ovv-ar' ? '0.5625' : null),
        style: { setProperty: (k, v) => { v2[k] = v; } },
        addEventListener: (t, f) => { (l2[t] = l2[t] || []).push(f); },
    };
    const fire2 = (t) => (l2[t] || []).forEach((f) => f());
    ctx.followShape(known);
    known.videoWidth = 720; known.videoHeight = 1280; fire2('resize');
    assert.strictEqual(v2['--ovv-ar'], undefined, 'the file matches the page: nothing moves');
    fire2('playing');
    assert.strictEqual(v2['--ovv-ar'], undefined);
    known.videoWidth = 1280; known.videoHeight = 720; fire2('resize');
    assert.strictEqual(v2['--ovv-ar'], '1.7778', 'a turn mid-stream is still followed');
}

assert.match(src, /followShape\(video\);\n\s+const t = startSeconds\(\);/, 'the watch page follows its video');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'video.css'), 'utf8');
assert.match(css, /\.ovv-player \{[^}]*aspect-ratio: var\(--ovv-ar, 16 \/ 9\);[^}]*max-height: calc\(100dvh - 150px\)/);
// A phone held sideways still fills the screen (its rule comes later and sets aspect-ratio: auto).
assert.ok(css.indexOf('aspect-ratio: var(--ovv-ar') < css.indexOf('video.ovv-player { aspect-ratio: auto; height: 100vh;'));

// The video first (2026-11-10). An upright picture is marked on its frame, and only a wide one is pinned on a phone.
{
    const marks = {}; const l3 = {};
    const tall = {
        videoWidth: 0, videoHeight: 0, getAttribute: (k) => (k === 'data-ovv-ar' ? '0.5625' : null),
        style: { setProperty: () => {} }, closest: (sel) => (sel === '.ovv-player-wrap' ? { classList: { toggle: (c, on) => { marks[c] = on; } } } : null),
        addEventListener: (t, f) => { (l3[t] = l3[t] || []).push(f); },
    };
    ctx.followShape(tall);
    assert.strictEqual(marks['is-upright'], true, 'a recording the page knows is upright is marked before it plays');
    (l3.playing || []).forEach((f) => f());
    tall.videoWidth = 1280; tall.videoHeight = 720; (l3.resize || []).forEach((f) => f());
    assert.strictEqual(marks['is-upright'], false, 'turned on its side mid-stream, the mark goes');
}
const phone = css.slice(css.lastIndexOf('@media (max-width: 600px) {'));
assert.match(phone, /\.ovv-watch \.ovv-player-wrap:not\(\.is-upright\) \{ position: sticky; top: var\(--ovnav-real-h, 52px\);/, 'a phone pins a wide player under the bar');
assert.match(phone, /html:has\(\.openvibe-navbar\.ovnav-hide\) \.ovv-watch \.ovv-player-wrap:not\(\.is-upright\) \{ top: 0; \}/, 'and at the top once the bar has stepped away');
assert.ok(!/\.is-upright\) \{[^}]*position: sticky[^}]*\}/.test(phone.replace(/:not\(\.is-upright\)/g, '')), 'an upright player is never pinned');
// Every piece of the page has its place in the one-column order: one without sat above the player ("More from", 11-09).
const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'video', 'pages.js'), 'utf8');
assert.ok(!/class="ovv-panel ovv-more"/.test(pages), 'the section beside the player is not the home page\'s .ovv-more link list');
const ordered = {};
// The last rule for a piece wins: the owner's tools were seventh, then moved under the player.
Array.from(css.matchAll(/\n {2}\.(ovv-[a-z]+) \{ order: (\d); \}/g)).forEach((x) => { ordered[x[1]] = Number(x[2]); });
assert.deepStrictEqual(ordered, { 'ovv-stage': 1, 'ovv-owner': 1, 'ovv-companion': 2, 'ovv-upnext': 3, 'ovv-about': 4, 'ovv-clips': 5, 'ovv-comments': 6, 'ovv-also': 7 }, 'the order of a watch page in one column');
const pieces = Array.from(pages.matchAll(/class="(?:ovv-panel )?(ovv-(?:also|clips|comments|companion|upnext|about|owner))[ "]/g)).map((x) => x[1]);
assert.ok(pieces.includes('ovv-also') && pieces.includes('ovv-clips') && pieces.includes('ovv-comments'), 'the pieces of the page are found in pages.js');
pieces.forEach((cls) => assert.ok(ordered[cls] >= 1, `${cls} has a place in the one-column order`));
console.log('✅ watch page player: the picture\'s shape once it plays, turns followed, resolution drops ignored; the video first');
