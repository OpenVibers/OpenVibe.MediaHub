'use strict';
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const owner = t.network.addUser('owner');
    const reader = t.network.addUser('reader');
    const outsider = t.network.addUser('outsider');
    const putShare = (id, body) => t.get(`/api/v1/download/${id}/share`, {
        as: owner, method: 'PUT', json: body, headers: { ...SAME, 'x-requested-with': 'ov-share' },
    });
    try {
        await check('new downloads have a share row and the upload audience controls page and bytes', async () => {
            const data = bytes(350, 'open');
            const made = await upload(t, owner, data, { name: 'open.txt' });
            assert.strictEqual(made.status, 201, made.text);
            const id = made.json().file.id;
            const row = await t.ctx.sharing.shareOf('download', id);
            assert.strictEqual(row.audience, 'public');
            assert.strictEqual((await t.get(`/files/${id}`)).status, 200);
            assert.ok((await t.get(`/files/${id}/download`)).buffer.equals(data));
            const ownPage = await t.get(`/files/${id}`, { as: owner });
            assert.ok(ownPage.text.includes(`data-kind="download" data-id="${id}"`));
            const transfer = await t.get(`/api/v1/download/${id}/share/transfer`, {
                as: owner, json: { to: { type: 'user', id: reader.subject }, keep_access: false }, headers: SAME,
            });
            assert.strictEqual(transfer.status, 409, transfer.text);

            const privateFile = (await upload(t, owner, bytes(360, 'private'), { name: 'private.txt', audience: 'private' })).json().file.id;
            assert.strictEqual((await t.get(`/files/${privateFile}`)).status, 404);
            assert.strictEqual((await t.get(`/files/${privateFile}/download`, { as: outsider })).status, 404);
            assert.strictEqual((await t.get(`/files/${privateFile}`, { as: owner })).status, 200);
            const linkFile = (await upload(t, owner, bytes(370, 'link'), { audience: 'link' })).json().file.id;
            assert.strictEqual((await t.get(`/files/${linkFile}`)).status, 200);
        });

        await check('Specific people gate both the page and bytes, and narrowing revokes old links', async () => {
            const data = bytes(420, 'named');
            const id = (await upload(t, owner, data, { name: 'named.txt' })).json().file.id;
            const legacy = (await share(t, owner, { file_id: id, public: true })).json().share.slug;
            const narrowed = await putShare(id, { audience: 'people', members: [{ subject: { type: 'user', id: reader.subject }, role: 'viewer' }] });
            assert.strictEqual(narrowed.status, 200, narrowed.text);
            assert.strictEqual((await t.get(`/files/${id}`)).status, 404);
            const denied = await t.get(`/files/${id}`, { as: outsider });
            assert.strictEqual(denied.status, 404);
            assert.ok(denied.text.includes('data-ov-share-gate') && !denied.text.includes('named.txt'));
            assert.strictEqual((await t.get(`/files/${id}/download`, { as: outsider })).status, 404);
            assert.strictEqual((await t.get(`/files/${id}`, { as: reader })).status, 200);
            assert.ok((await t.get(`/files/${id}/download`, { as: reader })).buffer.equals(data));
            assert.strictEqual((await t.get(`/s/${legacy}`)).status, 404);
        });

        await check('a shared folder hides and does not count a private new file', async () => {
            const folder = (await t.get('/api/v1/folders', { as: owner, json: { name: 'shared' }, headers: SAME })).json().folder;
            const id = (await upload(t, owner, bytes(430, 'folder secret'), { name: 'folder-secret.txt', folder: folder.id, audience: 'private' })).json().file.id;
            const slug = (await share(t, owner, { folder_id: folder.id, public: true })).json().share.slug;
            const page = await t.get(`/s/${slug}`);
            assert.strictEqual(page.status, 200, page.text);
            assert.ok(!page.text.includes('folder-secret.txt') && page.text.includes('0 files'));
            assert.strictEqual((await t.get(`/s/${slug}/f/${id}/download`)).status, 404);
        });

        await check('default plus apply to all changes only the owner’s files; upload may override it', async () => {
            const a = (await upload(t, owner, bytes(440, 'a'))).json().file.id;
            const b = (await upload(t, outsider, bytes(450, 'b'))).json().file.id;
            const saved = await t.get('/api/v1/share-defaults/download', { as: owner, method: 'PUT', json: { audience: 'private', apply: true }, headers: SAME });
            assert.strictEqual(saved.status, 200, saved.text);
            assert.ok(saved.json().changed >= 1);
            assert.strictEqual((await t.get(`/files/${a}`)).status, 404);
            assert.strictEqual((await t.get(`/files/${b}`)).status, 200);
            const next = (await upload(t, owner, bytes(460, 'next'))).json().file.id;
            assert.strictEqual((await t.ctx.sharing.shareOf('download', next)).audience, 'private');
            const override = (await upload(t, owner, bytes(470, 'override'), { audience: 'public' })).json().file.id;
            assert.strictEqual((await t.get(`/files/${override}`)).status, 200);
            const namedDefault = await t.get('/api/v1/share-defaults/download', { as: owner, method: 'PUT', json: { audience: 'people' }, headers: SAME });
            assert.strictEqual(namedDefault.status, 200, namedDefault.text);
            const named = (await upload(t, owner, bytes(480, 'named-default'))).json().file.id;
            assert.strictEqual((await t.ctx.sharing.shareOf('download', named)).audience, 'people');
            assert.strictEqual((await t.get(`/files/${named}`)).status, 404);
            assert.strictEqual((await t.get(`/files/${named}`, { as: owner })).status, 200);
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
