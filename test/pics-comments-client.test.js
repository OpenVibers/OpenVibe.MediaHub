'use strict';

const assert = require('node:assert/strict');
const { createCommentsClient } = require('../server/pics/comments-client');

(async () => {
    const calls = [];
    const token = 'person-token';
    const picture = 'pic_01JAB2C3D4E5F6G7H8J9K0MNP6';
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        assert.ok(url.startsWith('https://openvibe.community/api/v1/comments/'));
        if (url.endsWith('/threads/resolve')) return { status: 200, json: async () => ({ thread: { id: 'cth_1234567890123456789012' } }) };
        if (url.includes('/attachments')) {
            assert.ok(init.body instanceof FormData);
            const form = init.body;
            assert.deepEqual(JSON.parse(form.get('ref')), { service: 'pics', type: 'picture', id: picture });
            assert.equal(form.get('file').name, 'look.png');
            return { status: 201, json: async () => ({ attachment: { id: 'med_01JAB2C3D4E5F6G7H8J9K0MNP7' } }) };
        }
        if (init.method === 'DELETE') return { status: 200, json: async () => ({ ok: true }) };
        if (init.method === 'GET') return { status: 200, json: async () => ({ comments: [{ id: 4, message: 'hello' }], next_cursor: null }) };
        return { status: 201, json: async () => ({ comment: { id: 5, parent_id: 4 } }) };
    };
    const client = createCommentsClient({ fetchImpl });
    const page = await client.read(picture, token, { parent: 4, sort: 'new', after: 3 });
    assert.equal(page.status, 200);
    assert.equal(page.body.comments[0].message, 'hello');
    assert.match(calls[1].url, /parent=4/);
    assert.match(calls[1].url, /sort=new/);
    const added = await client.add(picture, token, { message: 'reply', parent_id: 4, attachments: [] });
    assert.equal(added.body.comment.parent_id, 4);
    assert.deepEqual(JSON.parse(calls[3].init.body), { message: 'reply', parent_id: 4, attachments: [] });
    const uploaded = await client.upload(picture, token, Buffer.from('look'), 'look.png', 'image/png');
    assert.equal(uploaded.status, 201);
    const removed = await client.remove('4', token);
    assert.equal(removed.status, 200);
    await client.read(picture, token, { sort: 'top' });
    assert.ok(calls.some((c) => c.url.includes('sort=top')));
    assert.ok(calls.every((c) => c.init.headers.Authorization === `Bearer ${token}`));
    process.stdout.write('Pics comments client read, reply, and upload pass\n');
})().catch((err) => { process.stderr.write(`${err.stack}\n`); process.exitCode = 1; });
