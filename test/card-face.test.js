'use strict';

/**
 * A recording or clip with no picture shows who made it (Shared's kit.card since 4.89.0, Live #546): the maker's face
 * from Network's /avatar/:username over a blur of it, only for a real username, and the kind's icon otherwise.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'video', 'pages.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'video.css'), 'utf8');
const fn = src.slice(src.indexOf('function cardPlaceholder('), src.indexOf('function card(o)'));

assert.ok(fn.includes("/^[A-Za-z0-9_]{1,32}$/.test(name)"), 'only a username becomes an avatar address');
assert.ok(fn.includes('${faceBase}/avatar/${name}?s=160'), 'Network\'s avatar, at the size it is drawn');
assert.ok(fn.includes('class="ovv-who-bg"') && fn.includes('class="ovv-who-face"'), 'the face over a blur of it');
assert.ok(fn.includes('<i class="ovg-fill" data-ov-icon="${icon}"></i>'), 'the icon when there is no username');
assert.ok(src.includes('${o.thumb ? thumbImg(o.thumb, CARD_SIZES) : cardPlaceholder(o, icon)}'), 'cards use it');
assert.ok(/faceBase = \/\^https\?:\\\/\\\/\/\.test\(String\(config\.networkUrl/.test(src), 'the origin comes from the config, and only an http(s) one');
for (const sel of ['.ovv-card-who .ovv-who-bg', '.ovv-card-who .ovv-who-face']) assert.ok(css.includes(sel), sel);

console.log('card-face: all passed');
