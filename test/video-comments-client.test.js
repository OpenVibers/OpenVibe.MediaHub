'use strict';

const assert = require('node:assert/strict');
const { createCommentsClient } = require('../server/video/comments-client');

(async () => {
    const calls = [];
    const id = 'vup_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const row = { id, title: 'Unlisted test' };
    const subject = 'usr_01JAB2C3D4E5F6G7H8J9K0MNPQ';
    const ref = { service: 'media-hub', type: 'video', id, label: row.title };
    const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        if (url === 'http://network/oauth/token') return reply({ access_token: 'service-token', expires_in: 300 });
        assert.equal(init.headers.Authorization, 'Bearer service-token');
        if (url.endsWith('/threads/resolve')) {
            assert.deepEqual(JSON.parse(init.body).ref, ref);
            return reply({ thread: { access_id: 'cth_1234567890123456789012' } });
        }
        if (url.endsWith('/attachments')) {
            assert.deepEqual(JSON.parse(init.body.get('ref')), ref);
            return reply({ attachment: { id: 'med_01JAB2C3D4E5F6G7H8J9K0MNP6' } }, 201);
        }
        if (url.endsWith('/123')) return reply({ comment: { author: { subject } }, thread: { ref } });
        if (url.includes('/threads/cth_') && init.method === 'GET') return reply({ thread: { ref }, comments: [], next_cursor: null, viewer: { can_comment: true } });
        if (init.method === 'DELETE') return reply({ ok: true });
        if (init.method === 'POST') return reply({ comment: { id: 123 } }, 201);
        throw new Error(url);
    };
    const client = createCommentsClient({ config: { networkInternalUrl: 'http://network', oauth: { clientId: 'media-hub', clientSecret: 'test' } }, fetchImpl });
    const answer = await client.read(row, { subject, sort: 'top' });
    assert.deepEqual(answer.comments, []);
    assert.ok(calls.some((c) => c.url.includes('sort=top')));
    await client.upload(row, subject, new File(['image'], 'look.png', { type: 'image/png' }));
    await client.add(row, subject, { message: 'hello' });
    await client.remove(row, subject, true, '123');
    assert.ok(calls.some((c) => c.init.headers['X-OV-Subject'] === subject));
    assert.ok(calls.some((c) => c.init.headers['X-OV-Staff'] === '1'));
    console.log('Video Community proxy read, upload, post and scoped removal pass');
})().catch((err) => { console.error(err); process.exitCode = 1; });
