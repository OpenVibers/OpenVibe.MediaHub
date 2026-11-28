'use strict';
// Chapter links on a /watch?v= page (11-28, found with openvibe.report/traffic): they were /watch?v=ID?t=31, whose
// id is "ID?t=31", so every chapter of every video answered 404. The time joins the address with & when it has a ?.
const assert = require('assert');
const { companion } = require('../server/video/watch-ui');

const chapters = [{ offset_seconds: 31, description: 'Intro' }, { offset_seconds: 95, description: 'The match' }];
const html = (o) => String(companion({ chat: null, transcript: null, long: false, downloads: false, ...o }));

const watch = html({ kind: 'vod', id: 6715, watchId: 'YxUugpcTjAQ', chapters });
const links = watch.match(/<a href="[^"]*" data-ovv-chapter/g) || [];
assert.strictEqual(links.length, 2, watch.slice(0, 300));
assert.match(links[0], /href="\/watch\?v=YxUugpcTjAQ&amp;t=31"/);
assert.ok(links.every((a) => (a.match(/\?/g) || []).length === 1), links.join(' '));

const plain = html({ kind: 'vod', id: 6715, watchId: null, chapters });
assert.match(plain, /href="\/v\/6715\?t=31"/, 'an address without ? still takes ?t=');
console.log('chapter-links: all passed');
