'use strict';
// An audio-only recording says so on its card ("Audio"), from Media #241's audio_only carried by Live's feed (#476);
// an AI clip keeps its own tag.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'video', 'pages.js'), 'utf8');
const fc = src.slice(src.indexOf('function feedCard('), src.indexOf('\n}\n', src.indexOf('function feedCard(')));
assert.ok(fc.includes("badge: item.ai ? 'AI clip' : (item.audio_only === true || item.audio_only === 1 ? 'Audio' : null),"), 'the card says Audio');
console.log('audio-tag: all passed');
