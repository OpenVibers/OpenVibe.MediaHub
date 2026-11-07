'use strict';
/**
 * The bin: a deleted file waits 30 days, still counted against storage, its share links dead at once; restoring it
 * puts it back in its folder without bringing a link back; deleting it forever (or the due job) soft-deletes the row
 * and asks Media to delete the object, in batches of 200. The store's clock is injected, so the 30 days can pass.
 *
 * Also here: the API's PATCH /files/:id, PATCH/DELETE /folders/:id, GET /files?q=, restore and ?forever=1, and the
 * sync key's limits on them.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

const DAY = 24 * 3_600_000;

(async () => {
    let clock = Date.now() + 1000;
    const t = await boot({ now: () => clock, env: { MEDIAHUB_QUOTA_BYTES: String(64 * 1024 * 1024) } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');

    const put = async (as, name, o = {}) => (await upload(t, as, bytes(60, name), { name, contentType: 'text/plain', ...o })).json().file;
    const folder = async (as, name, parentId = null) => (await t.get('/api/v1/folders', { as, json: { name, parent_id: parentId || undefined }, headers: SAME })).json().folder;
    const bin = (as, id) => t.get(`/api/v1/files/${id}`, { as, method: 'DELETE', headers: SAME });
    const binPage = (as = kim) => t.get('/files/bin', { as });
    const patch = (as, path, json, o = {}) => t.get(path, { as, method: 'PATCH', json, headers: SAME, ...o });

    let binnedFile = null;

    await check('deleting from the page puts the file in the bin, keeps its bytes and kills its links', async () => {
        const file = await put(kim, 'binned-page.txt');
        binnedFile = file;
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200);
        const before = (await t.get('/api/v1/usage', { as: kim })).json().usage;

        const deleted = await t.get(`/files/${file.id}/delete`, { as: kim, form: {}, headers: SAME });
        assert.strictEqual(deleted.status, 303);
        assert.strictEqual(deleted.headers.get('location'), '/files');

        const drive = (await t.get('/files', { as: kim })).text;
        assert.ok(!drive.includes('binned-page.txt'), 'it is out of the drive');
        assert.ok(drive.includes('href="/files/bin"'), 'the sidebar has the bin');
        assert.match(drive, /href="\/files\/bin"[^\n]*<em>1<\/em>/, 'with a count');
        assert.strictEqual((await t.get(`/files/${file.id}`, { as: kim })).status, 404, 'its page is gone');
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404, 'its link is dead at once');

        const after = (await t.get('/api/v1/usage', { as: kim })).json().usage;
        assert.strictEqual(after.files, before.files - 1, 'one fewer live file');
        assert.strictEqual(after.bytes_used, before.bytes_used, 'but the bytes still count against storage');

        const page = await binPage();
        assert.strictEqual(page.status, 200);
        for (const bit of ['binned-page.txt', `action="/files/${file.id}/restore"`, `action="/files/${file.id}/purge"`, 'Delete forever', 'Empty the bin', '30 days', 'still count against your storage']) {
            assert.ok(page.text.includes(bit), `the bin page has ${bit}`);
        }
    });

    await check('restore brings the file back to its folder; the share link stays dead', async () => {
        const work = await folder(kim, 'Restore work');
        const file = await put(kim, 'restore-me.txt', { folder: work.id });
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await bin(kim, file.id)).status, 204);
        assert.ok(!(await t.get(`/files?folder=${work.id}`, { as: kim })).text.includes('restore-me.txt'));

        const restored = await t.get(`/files/${file.id}/restore`, { as: kim, form: {}, headers: SAME });
        assert.strictEqual(restored.status, 303);
        assert.strictEqual(restored.headers.get('location'), '/files/bin');
        assert.ok((await t.get(`/files?folder=${work.id}`, { as: kim })).text.includes('restore-me.txt'), 'back in its folder');
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404, 'the link is not restored');
        assert.strictEqual((await t.get(`/files/${file.id}/restore`, { as: kim, form: {}, headers: SAME })).status, 404, 'a second restore is a 404');

        // The folder can go while a file in it sits in the bin; restoring then puts the file at the top.
        const gone = await folder(kim, 'Gone folder');
        const orphan = await put(kim, 'orphan.txt', { folder: gone.id });
        assert.strictEqual((await bin(kim, orphan.id)).status, 204);
        assert.strictEqual((await t.get(`/api/v1/folders/${gone.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204, 'the empty-looking folder goes');
        assert.strictEqual((await t.get(`/api/v1/files/${orphan.id}/restore`, { as: kim, json: {}, headers: SAME })).status, 200);
        const row = (await t.get(`/api/v1/files/${orphan.id}`, { as: kim })).json().file;
        assert.strictEqual(row.folder_id, null, 'it comes back at the top, not in a folder that is gone');
    });

    await check('the API can rename and move a file, and search every folder', async () => {
        const a = await folder(kim, 'API A');
        const b = await folder(kim, 'API B');
        const file = await put(kim, 'api-name.txt', { folder: a.id });

        const renamed = await patch(kim, `/api/v1/files/${file.id}`, { name: 'api-new.txt', folder_id: b.id });
        assert.strictEqual(renamed.status, 200, renamed.text);
        assert.strictEqual(renamed.json().file.name, 'api-new.txt');
        assert.strictEqual(renamed.json().file.folder_id, b.id, 'renamed and moved in one call');
        assert.ok((await t.get(`/files?folder=${b.id}`, { as: kim })).text.includes('api-new.txt'));

        const top = await patch(kim, `/api/v1/files/${file.id}`, { folder_id: null });
        assert.strictEqual(top.status, 200);
        assert.strictEqual(top.json().file.folder_id, null, 'null means the top');
        assert.strictEqual((await patch(kim, `/api/v1/files/${file.id}`, { name: '   ' })).status, 422);
        assert.strictEqual((await patch(kim, `/api/v1/files/${file.id}`, { folder_id: 'nope' })).json().code, 'folder.invalid');
        assert.strictEqual((await patch(kim, `/api/v1/files/${file.id}`, {})).json().code, 'file.invalid', 'nothing to change');
        assert.strictEqual((await patch(kim, '/api/v1/files/fil_01JABCDEFGHJKMNPQRSTVWXYZ0', { name: 'x' })).status, 404);
        assert.strictEqual((await patch(sam, `/api/v1/files/${file.id}`, { name: 'not-mine.txt' })).status, 404, 'somebody else\'s file is 404');

        // Search covers every folder; a binned file is not in it; a typed % is a character, not a wildcard.
        const found = await t.get('/api/v1/files?q=api-new', { as: kim });
        assert.strictEqual(found.status, 200);
        assert.strictEqual(found.json().folder_id, null);
        assert.strictEqual(found.json().q, 'api-new');
        assert.deepStrictEqual(found.json().files.map((f) => f.name), ['api-new.txt']);
        assert.deepStrictEqual(found.json().folders, []);
        assert.deepStrictEqual((await t.get('/api/v1/files?q=api-new', { as: sam })).json().files, [], 'nobody else\'s search');
        await bin(kim, file.id);
        assert.deepStrictEqual((await t.get('/api/v1/files?q=api-new', { as: kim })).json().files, [], 'binned files do not match');

        const percent = await put(kim, '100% done.txt');
        assert.strictEqual((await t.get('/api/v1/files?q=100%25', { as: kim })).json().files.length, 1, 'a % is itself');
        assert.ok((await t.get('/api/v1/files?q=done', { as: kim })).json().files.some((f) => f.id === percent.id));
    });

    await check('the API renames and deletes folders; a sync key may rename but not delete one', async () => {
        const made = await folder(kim, 'Folder One');
        const renamed = await patch(kim, `/api/v1/folders/${made.id}`, { name: 'Folder Two' });
        assert.strictEqual(renamed.status, 200, renamed.text);
        assert.strictEqual(renamed.json().folder.name, 'Folder Two');
        const other = await folder(kim, 'Folder Three');
        assert.strictEqual((await patch(kim, `/api/v1/folders/${made.id}`, { name: 'Folder Three' })).status, 409, 'no two of a name in one place');
        assert.strictEqual((await patch(kim, '/api/v1/folders/fld_01JABCDEFGHJKMNPQRSTVWXYZ0', { name: 'x' })).status, 404);

        const file = await put(kim, 'holds-the-folder.txt', { folder: made.id });
        assert.strictEqual((await t.get(`/api/v1/folders/${made.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 409, 'a folder with a file stays');
        assert.strictEqual((await t.get(`/api/v1/folders/${made.id}`, { as: kim, method: 'DELETE', headers: SAME })).json().code, 'folder.not_empty');
        assert.strictEqual((await t.get(`/api/v1/folders/${other.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204, 'an empty one goes');
        assert.strictEqual((await t.get(`/api/v1/folders/${other.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 404);

        const madeKey = await t.get('/sync/keys', { as: kim, form: { name: 'bin-test' }, headers: SAME });
        const key = (/ovdl_[A-Za-z0-9_-]{43}/.exec(madeKey.text) || [])[0];
        assert.ok(key, 'a sync key is made');
        assert.strictEqual((await patch(null, `/api/v1/files/${file.id}`, { name: 'key-rename.txt' }, { bearer: key })).status, 200, 'a key renames a file');
        assert.strictEqual((await patch(null, `/api/v1/folders/${made.id}`, { name: 'Key Folder' }, { bearer: key })).status, 200, 'and a folder');
        const refused = await t.get(`/api/v1/folders/${made.id}`, { bearer: key, method: 'DELETE', headers: SAME });
        assert.strictEqual(refused.status, 403);
        assert.strictEqual(refused.json().code, 'sync_key.not_allowed', 'but it may not delete one');
    });

    await check('delete forever asks Media for the bytes; a live file cannot be purged; the API restores', async () => {
        const file = await put(kim, 'forever.txt');
        const live = await t.get(`/api/v1/files/${file.id}?forever=1`, { as: kim, method: 'DELETE', headers: SAME });
        assert.strictEqual(live.status, 404, 'a file that is not in the bin is not purged');
        const restored = await t.get(`/api/v1/files/${file.id}/restore`, { as: kim, json: {}, headers: SAME });
        assert.strictEqual(restored.status, 404, 'and a live file cannot be restored');

        assert.strictEqual((await bin(kim, file.id)).status, 204);
        const before = t.media.deleted.length;
        const purge = await t.get(`/api/v1/files/${file.id}?forever=1`, { as: kim, method: 'DELETE', headers: SAME });
        assert.strictEqual(purge.status, 204, purge.text);
        assert.strictEqual(t.media.deleted.length, before + 1, 'Media was asked to delete the object');
        assert.strictEqual(t.media.deleted[t.media.deleted.length - 1], file.object.media_object_id);
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim })).status, 404);
        assert.ok(!(await binPage()).text.includes('forever.txt'));

        // Empty the bin deletes everything left in it for good.
        const one = await put(kim, 'empty-one.txt');
        const two = await put(kim, 'empty-two.txt');
        await bin(kim, one.id);
        await bin(kim, two.id);
        const beforeEmpty = t.media.deleted.length;
        const binned = Number(await t.ctx.s.db.value('SELECT count(*) FROM mh_files WHERE owner = $1 AND binned_at IS NOT NULL AND deleted_at IS NULL', [`user:${kim.subject}`]));
        assert.ok(binned >= 2, `the bin holds the empty-one/two and whatever came before (${binned})`);
        const emptied = await t.get('/files/bin/empty', { as: kim, form: {}, headers: SAME });
        assert.strictEqual(emptied.status, 303);
        assert.strictEqual(t.media.deleted.length, beforeEmpty + binned, 'every binned object went');
        assert.strictEqual(Number(await t.ctx.s.db.value('SELECT count(*) FROM mh_files WHERE owner = $1 AND binned_at IS NOT NULL AND deleted_at IS NULL', [`user:${kim.subject}`])), 0);
        assert.ok(!(await binPage()).text.includes('empty-one.txt'));
        assert.ok(!(await binPage()).text.includes('empty-two.txt'));
    });

    await check('the due job purges only after 30 days, in batches of 200', async () => {
        const file = await put(kim, 'due.txt');
        await bin(kim, file.id);
        const started = clock;
        clock += 29 * DAY;
        assert.strictEqual(await t.ctx.drive.purgeDue({ batch: 200 }), 0, 'not due yet');
        clock += 2 * DAY;
        const purged = await t.ctx.drive.purgeDue({ batch: 200 });
        assert.ok(purged >= 1, `the due file went (${purged})`);
        assert.ok(t.media.deleted.includes(file.object.media_object_id));
        clock = started;
        assert.ok(!(await binPage()).text.includes('due.txt'));
        const row = await t.ctx.s.db.maybe('SELECT deleted_at, binned_at FROM mh_files WHERE id = $1', [file.id]);
        assert.ok(row.deleted_at, 'the row is soft-deleted');
        assert.ok(row.binned_at, 'and still says when it was binned');

        // 205 due rows is two batches (200 then 5), not a 30-day timer.
        const old = new Date(clock - 40 * DAY).toISOString();
        await t.ctx.s.db.exec(
            `INSERT INTO mh_files (id, owner, object_id, name, size, content_type, sha256, folder_id, created_at, binned_at)
             SELECT 'fil_' || lpad(g::text, 26, '0'), $1, $2, 'old-' || g || '.bin', 1, 'text/plain', NULL, NULL, $3, $4
               FROM generate_series(1, 205) g`,
            [`user:${kim.subject}`, file.object.media_object_id, old, old]);
        const bulk = await t.ctx.drive.purgeDue({ batch: 200 });
        assert.strictEqual(bulk, 205, 'all batches, 200 at a time');
        const left = await t.ctx.s.db.value("SELECT count(*) FROM mh_files WHERE name LIKE 'old-%.bin' AND deleted_at IS NULL");
        assert.strictEqual(Number(left), 0);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
