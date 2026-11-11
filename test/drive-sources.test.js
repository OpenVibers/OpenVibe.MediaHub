'use strict';
/** The drive's root and search results include a person's read-only Pics and Video records. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const owner = `user:${kim.subject}`;
    const stamp = '2026-11-10T10:00:00.000Z';
    await t.ctx.s.db.exec(
        `INSERT INTO pics_images (id, slug, owner, title, object_id, mime_type, ext, width, height, bytes, sha256, source_sha256, dhash, created_at, updated_at)
         VALUES ('pic_01J0000000000000000000000A', 'AbCd1234', $1, 'Summer lake', 'med_pic_test', 'image/jpeg', 'jpg', 640, 480, 1234, 'a', 'b', '0123456789abcdef', $2, $2)`,
        [owner, stamp]);
    await t.ctx.s.db.exec(
        `INSERT INTO video_uploads (id, owner, title, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, status, state, created_at, updated_at)
         VALUES ('vup_01J0000000000000000000000B', $1, 'Lake walk', 'private', 77, 'video/mp4', 5678, 100, 1, 'ready', 'active', $2, $2)`,
        [owner, stamp]);
    await t.ctx.s.db.exec(
        `INSERT INTO video_uploads (id, owner, title, visibility, content_type, size_bytes, part_size, parts_expected, status, state, created_at, updated_at)
         VALUES ('vup_01J0000000000000000000000C', $1, 'Still uploading', 'private', 'video/mp4', 9, 9, 1, 'uploading', 'active', $2, $2)`,
        [owner, stamp]);

    await check('root includes own Pics and ready Video records with source links', async () => {
        const page = await t.get('/files', { as: kim });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('Summer lake') && page.text.includes('Open in Pics'));
        assert.ok(page.text.includes('Lake walk') && page.text.includes('Open in Video'));
        assert.ok(!page.text.includes('Still uploading'));
    });
    await check('search includes matching source records and excludes other owners', async () => {
        const page = await t.get('/files?q=lake', { as: kim });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('Summer lake') && page.text.includes('Lake walk'));
        assert.ok(!page.text.includes('Still uploading'));
    });
    await done(t);
})().catch((e) => { console.error(e); process.exitCode = 1; });
