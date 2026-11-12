'use strict';
// The video page's comment form: a picture alone is a comment (the owner, 11-12), words alone are, nothing is not.
const assert = require('assert');
const { readCommentForm } = require('../server/comments/form');
async function reqOf(fields) {
    const fd = new FormData();
    for (const [k, v] of fields) fd.append(k, v);
    const r = new Request('http://x/', { method: 'POST', body: fd });
    const body = Buffer.from(await r.arrayBuffer());
    return { body, get: (h) => (h.toLowerCase() === 'content-type' ? r.headers.get('content-type') : null) };
}
(async () => {
    const pic = new Blob([Buffer.from('png bytes')], { type: 'image/png' });
    const onlyPic = await readCommentForm(await reqOf([['message', ''], ['files', new File([pic], 'a.png', { type: 'image/png' })]]));
    assert.deepStrictEqual([onlyPic.message, onlyPic.files.length], ['', 1], 'a picture with no caption');
    const words = await readCommentForm(await reqOf([['message', '  nice  ']]));
    assert.deepStrictEqual([words.message, words.files.length], ['nice', 0]);
    await assert.rejects(readCommentForm(await reqOf([['message', '   ']])), /Write something or attach a picture/);
    await assert.rejects(readCommentForm(await reqOf([['message', 'x'.repeat(2001)]])), /up to 2,000 characters/);
    console.log('comment form: a picture alone, words alone, never nothing');
})().catch((e) => { console.error(e); process.exit(1); });
