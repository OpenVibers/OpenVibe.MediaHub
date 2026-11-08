'use strict';
/**
 * The owner deletes a recording or clip from the action row (a streamer, 11-08: deleting a test stream's recording
 * "wasn't immediately obvious": it was Edit, then a fold inside the edit panel, then a checkbox). Delete sits beside
 * Edit as a small question with one button; the form carries confirm=1 for the route's check; the edit panel no
 * longer hides a second delete.
 *
 *   node test/video-owner-delete.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { deleteAction } = require('../server/video/watch-ui');

const out = String(deleteAction({ action: '/v/42', what: 'recording' }));
assert.match(out, /<details class="ovv-pop ovv-deleter" data-ovv-menu>/, 'a small menu in the action row');
assert.match(out, /Delete this recording\?/, 'it asks first');
assert.match(out, /<form method="post" action="\/v\/42\/delete"><input type="hidden" name="confirm" value="1">/, 'the form confirms itself');
assert.match(out, /Delete for good<\/button>/, 'one button says what happens');

const pages = fs.readFileSync(path.join(__dirname, '..', 'server', 'video', 'pages.js'), 'utf8');
assert.ok(pages.includes("deleteAction({ action: `/v/${id}`, what: 'recording' })"), 'the recording page offers it beside Edit');
assert.ok(pages.includes("deleteAction({ action: `/c/${id}`, what: 'clip' })"), 'the clip page too');
const panel = pages.slice(pages.indexOf('function ownerPanel('), pages.indexOf('// The shell\'s navbar/footer scripts'));
assert.ok(!/ovv-danger|I want to delete it for good/.test(panel), 'the edit panel no longer hides a second delete');
console.log('video: Delete is beside Edit, one question, one button');
