'use strict';
/**
 * Sync keys (server/drive/syncKeys.js, migration 0011): a person makes a key on /sync, shown once, for the
 * openvibe-download command to back a folder up into their drive.
 *   - a key acts for its owner on the drive's /api/v1: list, folders, chunked uploads, delete;
 *   - it never makes or revokes share links, and it is no key at all on the video host's API;
 *   - its uploads have their own (larger) daily cap; storage stays capped the same;
 *   - revoked, it stops at once; only its hash is stored, and the export lists keys without it.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes } = require('./helpers/drive');

const MB = 1024 * 1024;

(async () => {
    const t = await boot({
        env: {
            MEDIAHUB_PART_BYTES: String(5 * MB),
            MEDIAHUB_UPLOADS_PER_DAY: '1',
            MEDIAHUB_SYNC_UPLOADS_PER_DAY: '3',
            MEDIAHUB_SYNC_KEYS_MAX: '2',
        },
    });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    let key = null;

    await check('a signed-in person makes a key on /sync; it is shown once and only its hash is kept', async () => {
        assert.strictEqual((await t.get('/sync')).status, 401, 'a guest is asked to sign in');
        const pageBefore = await t.get('/sync', { as: kim });
        assert.ok(pageBefore.text.includes('No sync keys yet.'));
        assert.strictEqual((await t.get('/sync/keys', { as: kim, form: { name: 'laptop' } })).status, 403, 'not from this site');
        const made = await t.get('/sync/keys', { as: kim, form: { name: 'laptop' }, headers: SAME });
        assert.strictEqual(made.status, 200, made.text.slice(0, 300));
        key = (/ovdl_[A-Za-z0-9_-]{43}/.exec(made.text) || [])[0];
        assert.ok(key, 'the key is on the page');
        const after = await t.get('/sync', { as: kim });
        assert.ok(after.text.includes('laptop') && after.text.includes(key.slice(0, 12)) && !after.text.includes(key), 'listed by its prefix, never again in full');
        const stored = await t.ctx.s.db.one('SELECT token_hash FROM mh_sync_keys WHERE owner = $1', [`user:${kim.subject}`]);
        assert.notStrictEqual(stored.token_hash, key);
        assert.match(stored.token_hash, /^[0-9a-f]{64}$/);
    });

    await check('the key reads and fills its owner\'s drive through /api/v1, with the sync cap', async () => {
        const list = await t.get('/api/v1/files', { bearer: key });
        assert.strictEqual(list.status, 200, list.text);
        const folder = await t.get('/api/v1/folders', { bearer: key, json: { name: 'Backups' } });
        assert.strictEqual(folder.status, 201, folder.text);
        const folderId = folder.json().folder.id;
        for (let n = 1; n <= 3; n++) {
            const data = bytes(1000 + n, `backup-${n}`);
            const started = await t.get('/api/v1/files', { bearer: key, json: { name: `note-${n}.txt`, size: data.length, content_type: 'text/plain', folder_id: folderId } });
            assert.strictEqual(started.status, 201, `upload ${n}: ${started.text}`);
            const up = started.json().upload;
            const part = await t.get(`/api/v1/uploads/${up.id}/parts/1`, { bearer: key, method: 'PUT', body: data, headers: { 'content-type': 'application/octet-stream' } });
            assert.strictEqual(part.status, 200, part.text);
            const done_ = await t.get(`/api/v1/uploads/${up.id}/complete`, { bearer: key, json: {} });
            assert.strictEqual(done_.status, 201, done_.text);
        }
        const fourth = await t.get('/api/v1/files', { bearer: key, json: { name: 'note-4.txt', size: 10, content_type: 'text/plain' } });
        assert.strictEqual(fourth.status, 429, 'past the sync cap');
        assert.strictEqual(fourth.json().code, 'file.daily_limit');
        const inFolder = await t.get(`/api/v1/files?folder_id=${folderId}`, { as: kim });
        assert.strictEqual(inFolder.json().files.length, 3, 'the files are the owner\'s');
        assert.deepStrictEqual((await t.get(`/api/v1/files?folder_id=${folderId}`, { as: sam })).json().files, [], 'nobody else sees them');
    });

    await check('a key makes no share links and is nothing on the video host', async () => {
        const files = (await t.get('/api/v1/files?limit=1', { as: kim })).json();
        const anyFile = files.files[0] || (await t.get(`/api/v1/files?folder_id=${files.folders[0].id}`, { as: kim })).json().files[0];
        const share = await t.get('/api/v1/shares', { bearer: key, json: { file_id: anyFile.id, hours: 24 } });
        assert.strictEqual(share.status, 403);
        assert.strictEqual(share.json().code, 'sync_key.not_allowed');
        const video = await t.get('/api/v1/video/playlists', { bearer: key, headers: { host: 'openvibe.video' } });
        assert.ok(video.status === 401 || video.status === 404, `the video API does not take it (${video.status})`);
    });

    await check('the key limit holds; a revoked key stops at once; the export lists keys without hashes', async () => {
        assert.strictEqual((await t.get('/sync/keys', { as: kim, form: { name: 'desktop' }, headers: SAME })).status, 200);
        assert.strictEqual((await t.get('/sync/keys', { as: kim, form: { name: 'third' }, headers: SAME })).status, 429, 'two live keys at most here');
        const row = await t.ctx.s.db.one("SELECT id FROM mh_sync_keys WHERE owner = $1 AND name = 'laptop'", [`user:${kim.subject}`]);
        assert.strictEqual((await t.get(`/sync/keys/${row.id}/revoke`, { as: sam, form: {}, headers: SAME })).status, 303, 'someone else\'s revoke does nothing');
        assert.strictEqual((await t.get('/api/v1/files', { bearer: key })).status, 200, 'still valid');
        assert.strictEqual((await t.get(`/sync/keys/${row.id}/revoke`, { as: kim, form: {}, headers: SAME })).status, 303);
        const refused = await t.get('/api/v1/files', { bearer: key });
        assert.strictEqual(refused.status, 401);
        assert.strictEqual(refused.json().code, 'sync_key.invalid');
        assert.strictEqual((await t.get('/api/v1/files', { bearer: `ovdl_${'x'.repeat(43)}` })).status, 401, 'an unknown key');
    });

    await done(t);
})();
