'use strict';
/**
 * The owner deletes a recording or clip from the More menu. Delete sits beside Edit there as a small question with
 * one button; the form carries confirm=1 for the route's check; the edit panel no longer hides a second delete.
 *
 *   node test/video-owner-delete.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { deleteAction } = require('../server/video/watch-ui');

const out = String(deleteAction({ action: '/v/42', what: 'recording' }));
assert.match(out, /<details class="ovv-pop ovv-deleter" data-ovv-menu>/, 'a small confirmation menu');
assert.match(out, /Delete this recording\?/, 'it asks first');
assert.match(out, /<form method="post" action="\/v\/42\/delete"><input type="hidden" name="confirm" value="1">/, 'the form confirms itself');
assert.match(out, /Delete for good<\/button>/, 'one button says what happens');

const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'video', 'pages.js'), 'utf8');
assert.ok(pages.includes('deleteAction({ action: `/${kind === \'clip\' ? \'c\' : \'v\'}/${id}`'), 'both watch pages offer Delete through More');
const panel = pages.slice(pages.indexOf('function ownerPanel('), pages.indexOf('// The shell\'s navbar/footer scripts'));
assert.ok(!/ovv-danger|I want to delete it for good/.test(panel), 'the edit panel no longer hides a second delete');
console.log('video: Delete is in More, one question, one button');
