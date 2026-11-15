'use strict';
// The watch page's Follow button (axe on /watch, 11-15): white on the live red itself is 3.8:1; the button's red is a
// fifth darker, so white reads at 5:1 or more, and hovering keeps the same base.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'video.css'), 'utf8');
const rule = (sel) => (new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css) || [])[1] || '';
assert.match(rule('.ovv-watch .ovv-follow'), /background: color-mix\(in srgb, var\(--live-red, #ef4444\), #000 20%\);/);
assert.match(rule('.ovv-watch .ovv-follow:hover'), /background: color-mix\(in srgb, var\(--live-red, #ef4444\), #000 20%\);/);
// #ef4444 a fifth toward black, against white text.
const mixed = [0xef, 0x44, 0x44].map((v) => v * 0.8);
const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = 1.05 / (lum(mixed) + 0.05);
assert.ok(ratio >= 4.5, `white on the button reads at ${ratio.toFixed(2)}:1`);
console.log(`follow contrast: white on the Follow button at ${ratio.toFixed(2)}:1`);
