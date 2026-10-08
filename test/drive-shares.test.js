'use strict';
/**
 * Share links: 24 random characters, an expiry of an hour to seven days, revocable, counted, and never open to
 * anybody who is not signed in. A share may name OpenVibe usernames; everybody else with the link is refused.
 *
 * The clock is the store's own (boot({ now })), so a share can be watched expiring.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

const HOUR = 3_600_000;

(async () => {
    // The injected clock drives the store and session verification, so it must not sit before the moment the
    // Network mock mints its tokens (an iat in the future is an invalid token).
    let clock = Date.now() + 1000;
    const t = await boot({ now: () => clock });
    // The injected clock also judges session tokens, so a test that moves it past a share's expiry would expire
    // the session too. Every request here carries a token minted for a day instead of an hour.
    const rawGet = t.get.bind(t);
    t.get = (path, o = {}) => (o.as
        ? rawGet(path, { ...o, cookie: `media-hub_at=${t.network.userToken(o.as, { ttl: 24 * 3600 })}` })
        : rawGet(path, o));
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');
    const ada = t.network.addUser('ada');

    const put = async (as, name, data = bytes(400, name)) => (await upload(t, as, data, { name })).json().file;
    const file = await put(kim, 'holiday.bin');

    await check('a share link is 24 random characters and expires when it was told to', async () => {
        const r = await share(t, kim, { file_id: file.id, hours: 24 });
        assert.strictEqual(r.status, 201, r.text);
        const s = r.json().share;
        assert.match(s.slug, /^[A-Za-z0-9_-]{24}$/);
        assert.strictEqual(s.state, 'live');
        assert.strictEqual(s.url, `/s/${s.slug}`);
        assert.strictEqual(s.expires_at, new Date(clock + 24 * HOUR).toISOString());
        assert.strictEqual((await share(t, kim, { file_id: file.id })).json().share.expires_at, new Date(clock + 7 * 24 * HOUR).toISOString(), 'seven days by default');

        // The clamp: an hour is the shortest, a week the longest.
        assert.strictEqual((await share(t, kim, { file_id: file.id, hours: 0 })).json().share.expires_at, new Date(clock + 7 * 24 * HOUR).toISOString());
        assert.strictEqual((await share(t, kim, { file_id: file.id, hours: 999 })).json().share.expires_at, new Date(clock + 7 * 24 * HOUR).toISOString());

        // A file that is not yours has no share.
        const sams = await put(sam, 'sams.bin');
        assert.strictEqual((await share(t, kim, { file_id: sams.id })).status, 404);
        assert.strictEqual((await share(t, kim, {})).status, 422);
    });

    await check('the share page and its download need a signed-in person', async () => {
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        const anon = await t.get(`/s/${slug}`);
        assert.strictEqual(anon.status, 401);
        assert.ok(anon.text.includes('Sign in first'), 'a sign-in page, not the file');
        assert.ok(!anon.text.includes('holiday.bin'), 'the name of the file is not shown to a guest');
        assert.strictEqual((await t.get(`/s/${slug}/download`)).status, 401);

        const asSam = await t.get(`/s/${slug}`, { as: sam });
        assert.strictEqual(asSam.status, 200);
        assert.ok(asSam.text.includes('holiday.bin'));
        assert.ok(asSam.text.includes('@kim'), 'who shared it: their OpenVibe username');
        assert.ok(!asSam.text.includes(kim.subject), 'and never their subject id');
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim })).json().shares.find((x) => x.slug === slug).downloads, 0);
        const dl = await t.get(`/s/${slug}/download`, { as: sam });
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(dl.headers.get('content-disposition'), `attachment; filename="holiday.bin"; filename*=UTF-8''holiday.bin`);
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim })).json().shares.find((x) => x.slug === slug).downloads, 1, 'the download is counted');
    });

    await check('a share can be revoked, and stops working at once', async () => {
        const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/shares/${slug}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204);
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/shares/${slug}`, { as: kim, method: 'DELETE', headers: SAME })).status, 204, 'revoking it twice is the same as revoking it once');
        assert.strictEqual((await t.get(`/api/v1/shares/not-a-slug-at-all-here`, { as: kim, method: 'DELETE', headers: SAME })).status, 404);
        // Somebody else's share is not theirs to revoke.
        const s2 = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await t.get(`/api/v1/shares/${s2}`, { as: sam, method: 'DELETE', headers: SAME })).status, 404);
    });

    await check('a share expires on its own', async () => {
        const slug = (await share(t, kim, { file_id: file.id, hours: 1 })).json().share.slug;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200);
        clock += 59 * 60 * 1000;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200, 'still inside the hour');
        clock += 2 * 60 * 1000;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404, 'past it');
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/files/${file.id}`, { as: kim })).json().shares.find((x) => x.slug === slug).state, 'expired');
    });

    await check('a share named for usernames is refused to everybody else', async () => {
        const r = await share(t, kim, { file_id: file.id, hours: 24, usernames: ['sam'] });
        assert.strictEqual(r.status, 201, r.text);
        const slug = r.json().share.slug;
        assert.deepStrictEqual(r.json().share.allowed, { subjects: [sam.subject], usernames: ['sam'] }, 'the name is resolved to the account; only the subject is matched');
        assert.deepStrictEqual(r.json().unresolved, []);
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200, 'sam is named');
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: sam })).status, 200);
        const adaPage = await t.get(`/s/${slug}`, { as: ada });
        assert.strictEqual(adaPage.status, 403);
        assert.ok(adaPage.text.includes('not for you'), adaPage.text.slice(0, 300));
        assert.strictEqual((await t.get(`/s/${slug}/download`, { as: ada })).status, 403);
        assert.ok(!adaPage.text.includes('holiday.bin'), 'not even the name');
        // The owner is named too, when they name themselves.
        assert.strictEqual((await share(t, kim, { file_id: file.id, hours: 24, usernames: ['not a name!'] })).status, 422);
        // A name no account has is refused: a typed name is never matched later (whoever registers it would get in).
        const nobody = await share(t, kim, { file_id: file.id, hours: 24, usernames: ['nobody_yet'] });
        assert.strictEqual(nobody.status, 422, nobody.text);
        assert.strictEqual(nobody.json().code, 'share.unknown_user');
    });

    await check('a folder can be shared, one file at a time', async () => {
        const folder = (await t.get('/api/v1/folders', { as: kim, headers: SAME, json: { name: 'photos' } })).json().folder;
        const inside = (await upload(t, kim, bytes(120, 'in-folder'), { name: 'in.png', folder: folder.id })).json().file;
        const outside = (await upload(t, kim, bytes(120, 'outside'), { name: 'out.png' })).json().file;
        const slug = (await share(t, kim, { folder_id: folder.id, hours: 24 })).json().share.slug;

        const page = await t.get(`/s/${slug}`, { as: sam });
        assert.strictEqual(page.status, 200);
        assert.ok(page.text.includes('photos') && page.text.includes('in.png'));
        assert.ok(!page.text.includes('out.png'), 'a file outside the folder is not in the share');

        const dl = await t.get(`/s/${slug}/f/${inside.id}/download`, { as: sam });
        assert.strictEqual(dl.status, 200, dl.text.slice(0, 200));
        assert.strictEqual((await t.get(`/s/${slug}/f/${outside.id}/download`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/s/${slug}/f/fil_01JABCDEFGHJKMNPQRSTVWXYZ0/download`, { as: sam })).status, 404);
    });

    await check('20 live share links is the most one person may have; revoked and expired ones do not count', async () => {
        const nia = t.network.addUser('nia');
        const f = await put(nia, 'spread.bin');
        const made = [];
        for (let i = 0; i < 20; i++) {
            const r = await share(t, nia, { file_id: f.id, hours: 1 });
            assert.strictEqual(r.status, 201, `share ${i}: ${r.text}`);
            made.push(r.json().share.slug);
        }
        const refused = await share(t, nia, { file_id: f.id, hours: 1 });
        assert.strictEqual(refused.status, 429);
        assert.strictEqual(refused.json().code, 'share.limit');
        assert.strictEqual((await t.get('/api/v1/usage', { as: nia })).json().usage.live_shares, 20);

        // Revoking one frees a slot...
        assert.strictEqual((await t.get(`/api/v1/shares/${made[0]}`, { as: nia, method: 'DELETE', headers: SAME })).status, 204);
        assert.strictEqual((await share(t, nia, { file_id: f.id, hours: 1 })).status, 201, 'a revoked one frees a slot');
        assert.strictEqual((await t.get('/api/v1/usage', { as: nia })).json().usage.live_shares, 20);
        // ...and so does the hour passing.
        clock += 2 * HOUR;
        assert.strictEqual((await t.get('/api/v1/usage', { as: nia })).json().usage.live_shares, 0, 'the old ones expired');
        assert.strictEqual((await share(t, nia, { file_id: f.id, hours: 1 })).status, 201);
    });

    await check('deleting a file takes its share links with it', async () => {
        const ola = t.network.addUser('ola');
        const f = await put(ola, 'doomed.bin');
        const slug = (await share(t, ola, { file_id: f.id, hours: 24 })).json().share.slug;
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 200);
        assert.strictEqual((await t.get(`/api/v1/files/${f.id}`, { as: ola, method: 'DELETE', headers: SAME })).status, 204);
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/files/${f.id}`, { as: ola })).status, 404, 'and the file is gone for its owner too');
        assert.ok(t.media.deleted.length > 0, 'Media was asked to delete the object');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
