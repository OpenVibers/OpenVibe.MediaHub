'use strict';
const assert = require('node:assert/strict');
const { renderThread } = require('../server/comments/inline');

const answer = {
    thread: { id: 'cth_1234567890123456789012' }, viewer: { can_comment: true },
    comments: [{ id: 10, message: 'A <picture>', author: { username: 'alice', display_name: 'Alice', avatar_url: 'https://openvibe.network/avatar/alice' },
        created_at: '2026-11-10T12:00:00Z', reply_count: 3, can_delete: true,
        attachments: [{ id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPQ', name: 'image.png', media_type: 'image/png' },
            { id: 'med_01JAB2C3D4E5F6G7H8J9K0MNPR', name: 'notes.pdf', media_type: 'application/pdf' }],
        replies: [{ id: 11, parent_id: 10, reply_to_id: 10, reply_to: { display_name: 'Alice' }, message: 'First', author: { username: 'bob', display_name: 'Bob' } },
            { id: 12, parent_id: 10, reply_to_id: 11, reply_to: { display_name: 'Bob' }, message: 'Second', author: { username: 'alice', display_name: 'Alice' } }],
    }],
};
const options = { answer, base: '/watch?v=12345678901', post: '/u/vup_1/comments', remove: '/u/vup_1/comments/delete', sort: 'top' };
const signedOut = renderThread({ ...options, signedIn: false });
assert.match(signedOut, /class="ovc-thread"/);
assert.match(signedOut, /Sign in to comment/);
assert.doesNotMatch(signedOut, /data-ovt-composer/);
assert.doesNotMatch(signedOut, /class="ovc-order"/, 'one top-level comment has nothing to put in order');
const two = renderThread({ ...options, answer: { ...answer, comments: [...answer.comments, { ...answer.comments[0], id: 20, replies: [], reply_count: 0 }] }, signedIn: false });
assert.match(two, /class="ovc-order"/);
assert.match(two, /sort=new/);
assert.match(signedOut, /1 more reply/);
assert.match(signedOut, /href="https:\/\/openvibe.network\/@alice"/);
assert.match(signedOut, /class="ovc-target"/);
assert.match(signedOut, /&lt;picture&gt;/);
assert.match(signedOut, /<img src="https:\/\/openvibe.media\/o\/med_/);
assert.match(signedOut, /notes.pdf/);
assert.match(signedOut, /%2Fwatch%3Fv%3D12345678901%26sort%3Dtop/);
const signedIn = renderThread({ ...options, signedIn: true, replyId: 11 });
assert.match(signedIn, /data-ovt-composer/);
assert.match(signedIn, /name="parent_id" value="11"/);
assert.match(signedIn, /data-ovt-files/);
assert.match(signedIn, /name="comment_id" value="10"/);
const emptyOut = renderThread({ ...options, answer: { ...answer, comments: [] }, signedIn: false });
assert.match(emptyOut, /<p class="ovc-signin">Be the first to comment\. <a /, 'signed out with no comments: one line, sign-in beside it');
assert.doesNotMatch(emptyOut, /ovk-empty/, 'no second box saying the same thing');
assert.match(renderThread({ ...options, answer: { ...answer, comments: [] }, signedIn: true }), /<p class="ovc-none">Be the first to comment\.<\/p>/);
process.stdout.write('Inline thread renders replies, targets, attachments, order, composer and signed-out state\n');
