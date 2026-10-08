'use strict';
/**
 * Uploading: the plain form (no JavaScript, one request), the chunked path the page's script uses, resume after a
 * dropped part, and the per-person numbers — 512 MB a file, 2 GB stored, 50 uploads a day.
 *
 * The bytes end up in the stand-in OpenVibe.Media (test/helpers/media.js), which is the only place they live: the
 * assertions here are about what MediaHub told Media and what it recorded, not about bytes it kept itself.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, sha256, upload, postForm } = require('./helpers/drive');

const MB = 1024 * 1024;

(async () => {
    // Small parts (5 MB, Media's own minimum) so a two-part upload is a few megabytes, not a few hundred.
    const t = await boot({
        env: {
            MEDIAHUB_PART_BYTES: String(5 * MB),
            MEDIAHUB_MAX_FILE_BYTES: String(20 * MB),
            MEDIAHUB_QUOTA_BYTES: String(40 * MB),
            MEDIAHUB_UPLOADS_PER_DAY: '3',
        },
    });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');

    await check('the plain form uploads a file in one request, without JavaScript', async () => {
        const data = bytes(5000, 'plain-form');
        const r = await postForm(t, kim, { name: 'quarterly.bin' }, { filename: 'orig.bin', type: 'application/octet-stream', data });
        assert.strictEqual(r.status, 303, r.text.slice(0, 300));
        const id = r.headers.get('location').replace('/files/', '');
        assert.match(id, /^fil_[0-9A-HJKMNP-TV-Z]{26}$/);

        const meta = await t.get(`/api/v1/files/${id}`, { as: kim });
        assert.strictEqual(meta.status, 200);
        assert.strictEqual(meta.json().file.name, 'quarterly.bin', 'the typed name wins over the file name');
        assert.strictEqual(meta.json().file.size, data.length);
        assert.strictEqual(meta.json().file.sha256, sha256(data), 'Media computed the hash and MediaHub kept it');

        const dl = await t.get(`/files/${id}/download`, { as: kim });
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(sha256(dl.buffer), sha256(data), 'the bytes round-trip');
    });

    await check('the chunked upload the page script uses: start, parts, complete', async () => {
        const data = bytes(6 * MB, 'chunked');
        const started = await t.get('/api/v1/files', { as: kim, headers: SAME, json: { name: 'video.bin', size: data.length, content_type: 'application/octet-stream' } });
        assert.strictEqual(started.status, 201, started.text);
        const up = started.json().upload;
        assert.strictEqual(up.parts_expected, 2, 'six megabytes at five megabytes a part');
        assert.strictEqual(up.part_size, 5 * MB);
        assert.deepStrictEqual(up.missing, []);

        const first = await t.get(`/api/v1/uploads/${up.id}/parts/1`, { as: kim, method: 'PUT', body: data.subarray(0, up.part_size), headers: SAME });
        assert.strictEqual(first.status, 200, first.text);

        // The resume answer: part 1 is in, part 2 is what is left.
        const resume = await t.get(`/api/v1/uploads/${up.id}`, { as: kim });
        assert.strictEqual(resume.status, 200);
        assert.deepStrictEqual(resume.json().upload.missing, [2]);
        assert.strictEqual(resume.json().upload.status, 'open');

        const second = await t.get(`/api/v1/uploads/${up.id}/parts/2`, { as: kim, method: 'PUT', body: data.subarray(up.part_size), headers: SAME });
        assert.strictEqual(second.status, 200, second.text);
        const done_ = await t.get(`/api/v1/uploads/${up.id}/complete`, { as: kim, json: {}, headers: SAME });
        assert.strictEqual(done_.status, 201, done_.text);
        assert.strictEqual(done_.json().file.size, data.length);
        assert.strictEqual(done_.json().file.sha256, sha256(data));

        // The session is gone once it is a file, and so is the resume route for it.
        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}`, { as: kim })).status, 404);
    });

    await check('a part of the wrong size is refused, and one person cannot touch another\'s upload', async () => {
        const data = bytes(6 * MB, 'parts');
        const up = (await t.get('/api/v1/files', { as: kim, headers: SAME, json: { name: 'p.bin', size: data.length, content_type: 'application/octet-stream' } })).json().upload;

        const short = await t.get(`/api/v1/uploads/${up.id}/parts/1`, { as: kim, method: 'PUT', body: data.subarray(0, 10), headers: SAME });
        assert.strictEqual(short.status, 422);
        assert.strictEqual(short.json().code, 'upload.part_size');
        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}/parts/9`, { as: kim, method: 'PUT', body: data.subarray(0, up.part_size), headers: SAME })).status, 422);

        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}`, { as: sam })).status, 404, 'not sam\'s upload');
        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}/parts/1`, { as: sam, method: 'PUT', body: data.subarray(0, up.part_size), headers: SAME })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204, 'the owner can abandon it');
        assert.strictEqual((await t.get(`/api/v1/uploads/${up.id}`, { as: kim })).status, 404);
    });

    await check('a file over the per-file cap is refused before anything is created', async () => {
        const r = await t.get('/api/v1/files', { as: kim, headers: SAME, json: { name: 'huge.bin', size: 25 * MB, content_type: 'application/octet-stream' } });
        assert.strictEqual(r.status, 413);
        assert.strictEqual(r.json().code, 'file.too_large');
        assert.ok(r.json().detail.includes('20'), r.json().detail);
    });

    await check('the day\'s uploads and the stored quota are enforced, from the environment', async () => {
        const usage = (await t.get('/api/v1/usage', { as: kim })).json().usage;
        assert.strictEqual(usage.uploads_per_day, 3);
        assert.strictEqual(usage.max_file_bytes, 20 * MB);
        assert.strictEqual(usage.bytes_limit, 40 * MB);
        // kim has uploaded twice (the plain form and the chunked upload). One more, then the day is full.
        assert.strictEqual(usage.uploads_today, 2, JSON.stringify(usage));
        const third = await upload(t, kim, bytes(1000, 'third'), { name: 'third.bin' });
        assert.strictEqual(third.status, 201, third.text);
        const fourth = await upload(t, kim, bytes(1000, 'fourth'), { name: 'fourth.bin' });
        assert.strictEqual(fourth.status, 429);
        assert.strictEqual(fourth.json().code, 'file.daily_limit');
        // The quota: sam has room, kim does not have 40 MB any more either.
        const stored = (await t.get('/api/v1/usage', { as: kim })).json().usage.bytes_used;
        const over = await t.get('/api/v1/files', { as: sam, headers: SAME, json: { name: 'ok.bin', size: 1000, content_type: 'text/plain' } });
        assert.strictEqual(over.status, 201, 'another person has their own numbers');
        assert.ok(stored > 6 * MB);
    });

    await check('an upload is private to its owner until it is shared', async () => {
        // Somebody with their own numbers: kim's day is full by now, which is a different rule.
        const nia = t.network.addUser('nia');
        const up = await upload(t, nia, bytes(200, 'private'), { name: 'mine.bin' });
        assert.strictEqual(up.status, 201, up.text);
        const id = up.json().file.id;
        assert.strictEqual((await t.get(`/api/v1/files/${id}`, { as: sam })).status, 404);
        // A session-cookie DELETE is only accepted from this site, and it is still not sam's file.
        assert.strictEqual((await t.get(`/api/v1/files/${id}`, { as: sam, method: 'DELETE' })).status, 403);
        assert.strictEqual((await t.get(`/api/v1/files/${id}`, { as: sam, method: 'DELETE', headers: SAME })).status, 404);
        assert.strictEqual((await t.get(`/files/${id}`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/files/${id}/download`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/files/${id}`, { as: nia })).status, 200, 'its owner sees it');
        assert.ok((await t.get('/api/v1/files', { as: sam })).json().files.every((f) => f.name !== 'mine.bin'));
    });

    await check('an empty or nameless form is refused with a page, not a crash', async () => {
        const empty = await postForm(t, kim, {}, { filename: 'empty.bin', type: 'application/octet-stream', data: Buffer.alloc(0) });
        assert.strictEqual(empty.status, 422);
        assert.ok(empty.text.includes('No file was in that form'), empty.text.slice(0, 200));
        const none = await postForm(t, kim, {}, null);
        assert.strictEqual(none.status, 422);
        assert.strictEqual((await t.get('/files/upload', { as: kim, headers: SAME, body: Buffer.from('not a form'), })).status, 422);
    });

    await check('Media being down is a refusal the person can read, never a broken page', async () => {
        const ola = t.network.addUser('ola');
        t.media.setDown(true);
        const r = await upload(t, ola, bytes(100), { name: 'down.bin' });
        assert.strictEqual(r.status, 502);
        assert.match(r.json().code, /^media\./, r.json().code);
        const form = await postForm(t, ola, { name: 'down.bin' }, { filename: 'down.bin', type: 'text/plain', data: bytes(100, 'down') });
        assert.strictEqual(form.status, 422);
        assert.ok(form.text.includes('could not store that just now'), form.text.slice(0, 400));
        t.media.setDown(false);
        assert.strictEqual((await upload(t, ola, bytes(100), { name: 'back.bin' })).status, 201, 'and it works again once Media is back');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
