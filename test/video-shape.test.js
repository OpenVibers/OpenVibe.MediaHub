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
    videoWidth: 0, videoHeight: 0,
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

assert.match(src, /followShape\(video\);\n\s+const t = startSeconds\(\);/, 'the watch page follows its video');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'video.css'), 'utf8');
assert.match(css, /\.ovv-player \{[^}]*aspect-ratio: var\(--ovv-ar, 16 \/ 9\);[^}]*max-height: calc\(100dvh - 150px\)/);
// A phone held sideways still fills the screen (its rule comes later and sets aspect-ratio: auto).
assert.ok(css.indexOf('aspect-ratio: var(--ovv-ar') < css.indexOf('video.ovv-player { aspect-ratio: auto; height: 100vh;'));
console.log('✅ watch page player: the picture\'s shape once it plays, turns followed, resolution drops ignored');
