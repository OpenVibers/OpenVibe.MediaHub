'use strict';
// OpenVibe.Video chapters: a long stream's AI moments become at most twelve chapters, a twelfth of the stream
// apart, titled by what was seen (Live appends ' — heard: "…"', which the transcript already carries).
const assert = require('assert');
const { chapters, chapterTitle } = require('../server/video/pages');

// A 2 h 24 min stream with a moment every 2.5 minutes (66 of them, as on production VOD 5717).
const mems = Array.from({ length: 66 }, (_, i) => ({ offset_seconds: 16 + i * 150, description: `Moment ${i} — heard: "words ${i}"` }));
const out = chapters(mems, 8638);
assert.ok(out.length <= 12, `at most twelve, got ${out.length}`);
assert.strictEqual(out[0].offset_seconds, 16, 'the first moment opens the first chapter');
for (let i = 1; i < out.length; i++) assert.ok(out[i].offset_seconds - out[i - 1].offset_seconds >= 8638 / 12, 'a twelfth of the stream apart');
assert.strictEqual(out[0].description, 'Moment 0', 'the heard part is dropped');

// A short clip-length recording keeps close moments (the gap is a twelfth of 45 s).
assert.deepStrictEqual(chapters([{ offset_seconds: 10, description: 'Intro' }, { offset_seconds: 30, description: 'Main' }], 45).map((c) => c.offset_seconds), [10, 30]);

// A moment with only what was heard (no title), or past the video's end, is no chapter (VOD 6026: "0:16 " and 41:16 in 32:01).
assert.deepStrictEqual(chapters([{ offset_seconds: 16, description: ' — heard: "hey"' }, { offset_seconds: 287, description: 'A campsite' }, { offset_seconds: 2476, description: 'Later' }], 1921)
    .map((c) => [c.offset_seconds, c.description]), [[287, 'A campsite']]);

// Titles: a trailing period goes; a long one is cut at a word with an ellipsis.
assert.strictEqual(chapterTitle('A streamer waves.'), 'A streamer waves');
const long = chapterTitle('word '.repeat(40));
assert.ok(long.length <= 91 && long.endsWith('…'), long);
console.log('✅ video chapters: at most twelve, evenly spaced, titled by what was seen');
