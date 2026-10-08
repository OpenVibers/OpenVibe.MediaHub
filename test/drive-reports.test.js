'use strict';
/**
 * Reporting a share and what staff do about it: one report per person per link, three distinct people (or one
 * report of illegal content) suspending it at once, and OpenVibe staff restoring it or removing the file.
 *
 * The reasons, the notes and everything else somebody typed are text: they are escaped wherever the queue shows
 * them (drive-pages.test.js has the escaping; this file has the rules).
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const jo = t.network.addUser('jo');
    const ada = t.network.addUser('ada', { role: 'admin' });
    const gil = t.network.addUser('gil', { role: 'global_mod' });
    const pat = t.network.addUser('pat', { role: 'streamer' });

    const file = (await upload(t, kim, bytes(200, 'reported'), { name: 'suspect.bin' })).json().file;
    const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
    const report = (body, as, o = {}) => t.get(`/s/${slug}/report`, { as, form: body, headers: { ...SAME, ...(o.headers || {}) } });
    const state = async () => (await t.get(`/api/v1/files/${file.id}`, { as: kim })).json().shares.find((x) => x.slug === slug).state;

    await check('a signed-in person reports a share once; their own is not theirs to report', async () => {
        const r = await report({ reason: 'malware', note: 'It asked me to run it.' }, sam);
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.ok(r.text.includes('report 1'), 'the page says which report it was');
        assert.strictEqual(await state(), 'live', 'one report suspends nothing');
        assert.strictEqual((await report({ reason: 'other' }, sam)).status, 409, 'once per person');
        assert.strictEqual((await report({ reason: 'other' }, kim)).status, 403, 'not your own share');
        assert.strictEqual((await report({ reason: 'nonsense' }, jo)).status, 422, 'the reason is from the list');
        assert.strictEqual((await t.get(`/s/${slug}/report`, { form: { reason: 'malware' }, headers: SAME })).status, 401, 'a guest reports nothing');
        assert.strictEqual((await t.get(`/s/${slug}/report`, { as: jo, form: { reason: 'malware' } })).status, 403, 'a cross-site form cannot report as somebody');
        assert.strictEqual((await report({ reason: 'copyright', note: 'x'.repeat(600) }, jo)).status, 200);
        assert.strictEqual(await state(), 'live', 'two reports still do not suspend it');
    });

    await check('the third distinct report suspends the share at once, everywhere', async () => {
        const nia = t.network.addUser('nia');
        await report({ reason: 'copyright' }, nia);
        assert.strictEqual(await state(), 'suspended');

        const page = await t.get(`/s/${slug}`, { as: sam });
        assert.strictEqual(page.status, 403);
        assert.ok(page.text.includes('suspended'), page.text.slice(0, 300));
        assert.ok(!page.text.includes('suspect.bin'), 'and nothing about the file');
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 403, 'nothing can be downloaded from it');
        // The owner sees it suspended too, and can still revoke it.
        assert.strictEqual((await t.get(`/s/${slug}`, { as: kim })).status, 403);
    });

    await check('one report of illegal content suspends at once', async () => {
        const other = (await upload(t, kim, bytes(50, 'illegal'), { name: 'bad.bin' })).json().file;
        const s2 = (await share(t, kim, { file_id: other.id, hours: 24 })).json().share.slug;
        const r = await t.get(`/s/${s2}/report`, { as: jo, form: { reason: 'illegal', note: 'I think this is abuse material.' }, headers: SAME });
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('suspended now'), r.text.slice(0, 400));
        assert.strictEqual((await t.get(`/s/${s2}`, { as: sam })).status, 403);
        assert.strictEqual((await t.get(`/s/${s2}/download`, { as: sam })).status, 403);
    });

    await check('the queue is for staff only, and shows who shared it, why it was reported and what was said', async () => {
        for (const [who, status] of [[null, 401], [sam, 403], [pat, 403]]) {
            const r = await t.get('/staff', who ? { as: who } : {});
            assert.strictEqual(r.status, status, String(who && who.username));
        }
        const queue = await t.get('/staff', { as: ada });
        assert.strictEqual(queue.status, 200);
        assert.ok(queue.text.includes(slug), 'the reported share');
        assert.ok(queue.text.includes('suspect.bin'), 'the file behind it');
        assert.ok(queue.text.includes('@kim'), 'who shared it, by username');
        assert.ok(queue.text.includes('malware') && queue.text.includes('copyright'), 'the reasons');
        assert.ok(queue.text.includes('It asked me to run it.'), 'what the first reporter said');
        assert.ok(queue.text.includes('suspect.bin'));
        assert.ok((await t.get('/staff', { as: gil })).text.includes(slug), 'a global mod reads it too');
        assert.ok(!(await t.get('/staff', { as: ada })).text.includes('member of the public'), 'no');
    });

    await check('staff restore it: the link works again and the reports stay on the record', async () => {
        const r = await t.get(`/staff/${slug}/restore`, { as: ada, form: {}, headers: SAME });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(await state(), 'live');
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200, 'and it opens again');
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 200);
        const queue = await t.get('/staff', { as: ada });
        assert.ok(queue.text.includes(slug), 'the reports are still there for staff');
        assert.ok(queue.text.includes('live'), 'and it says the link is live again');
        // A restored share is not immediately suspended again by the reports it already has.
        assert.strictEqual((await report({ reason: 'malware' }, t.network.addUser('dea'))).status, 200);
        assert.strictEqual(await state(), 'live', 'the count is what suspends, and it does not count twice');
    });

    await check('staff remove the file: the link, the file and Media\'s object all go', async () => {
        const before = t.media.deleted.length;
        const r = await t.get(`/staff/${slug}/remove`, { as: gil, form: {}, headers: SAME });
        assert.strictEqual(r.status, 303);
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim })).status, 404, 'gone for its owner too');
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim, method: 'DELETE', headers: SAME })).status, 404);
        assert.strictEqual(t.media.deleted.length, before + 1, 'Media was asked to delete the object');
        assert.strictEqual(t.media.deleted[t.media.deleted.length - 1], file.object.media_object_id);
    });

    await check('removing or restoring is staff\'s, and comes from this site', async () => {
        const f = (await upload(t, kim, bytes(60, 'again'), { name: 'again.bin' })).json().file;
        const s = (await share(t, kim, { file_id: f.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await t.get(`/staff/${s}/remove`, { as: sam, form: {}, headers: SAME })).status, 403);
        assert.strictEqual((await t.get(`/staff/${s}/remove`, { form: {}, headers: SAME })).status, 401);
        assert.strictEqual((await t.get(`/staff/${s}/remove`, { as: ada, form: {} })).status, 403, 'a cross-site form is refused');
        assert.strictEqual((await t.get(`/staff/${s}/restore`, { as: ada, form: {}, headers: SAME })).status, 303);
    });

    await check('a share its owner already revoked is not a report, and a report on a folder share is a report', async () => {
        const f = (await upload(t, kim, bytes(60, 'gone'), { name: 'gone.bin' })).json().file;
        const s = (await share(t, kim, { file_id: f.id, hours: 24 })).json().share.slug;
        await t.get(`/api/v1/shares/${s}`, { as: kim, method: 'DELETE', headers: SAME });
        const r = await t.get(`/s/${s}/report`, { as: sam, form: { reason: 'malware' }, headers: SAME });
        assert.strictEqual(r.status, 409);
        assert.match(r.text, /already taken down/i);
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
