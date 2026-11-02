'use strict';
// Pics' pink accent text and its table headers reach WCAG AA on light themes (axe on Daylight, 2026-11-01): the
// accent mix was 72% pink (4.3:1 on white) and the headers named --text-faint, which no theme sets (3.7:1 fallback).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'pics.css'), 'utf8');
assert.match(css, /--ovp-accent-text: color-mix\(in srgb, var\(--ovp-pink\) 60%, var\(--text-primary, #e6edf7\)\);/);
assert.match(css, /\.ovp-size-table thead th \{[^}]*color: var\(--ovp-faint\);/);
assert.ok(!/var\(--text-faint/.test(css), 'no colour names --text-faint');
console.log('pics contrast: all checks passed');
