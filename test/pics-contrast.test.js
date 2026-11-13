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
// The shared presence sheet also writes `.ovp-btn` (transparent background, colour inherit). Every Pics button rule
// is scoped to the page, so a later plain `.ovp-btn` cannot repaint the pink primary button (the 11-13 phone shot).
assert.ok(!/(^|\n)\.ovp-btn(?=[\s,:{])/m.test(css), 'no unscoped .ovp-btn selector competes with the shared sheet');
assert.match(css, /\.ovp-page \.ovp-btn \{[^}]*min-height: 44px;/);
assert.match(css, /\.ovp-page \.ovp-btn--primary \{[^}]*background: var\(--ovp-pink\);/);
console.log('pics contrast: all checks passed');
