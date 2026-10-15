'use strict';
/**
 * Public share links (migrations/0007_public_shares.sql; the owner's Q10, MediaFire-style): a share marked public opens
 * and downloads for anyone with the link, signed in or not; it cannot also name accounts; a signed-out visitor can
 * report it (counted by a keyed hash of their address); reports still suspend it; an ordinary link still needs an
 * account. Free accounts hold 25 GB with files up to 2 GB.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    try {
        const file = (await upload(t, kim, bytes(500, 'public'), { name: 'notes.txt', contentType: 'text/plain' })).json().file;

        await check('a public link opens and downloads with no account; an ordinary link still asks to sign in', async () => {
            const pub = await share(t, kim, { file_id: file.id, public: true, hours: 24 * 30 });
            assert.strictEqual(pub.status, 201, pub.text);
            assert.strictEqual(pub.json().share.public, true);
            const slug = pub.json().share.slug;
            const page = await t.get(`/s/${slug}`);
            assert.strictEqual(page.status, 200, page.text.slice(0, 200));
            assert.ok(page.text.includes('notes.txt') && page.text.includes('Shared publicly'));
            const dl = await t.get(`/s/${slug}/download`);
            assert.strictEqual(dl.status, 200);
            assert.ok(dl.buffer.equals(bytes(500, 'public')), 'the file, to anyone with the link');

            const plain = (await share(t, kim, { file_id: file.id })).json().share.slug;
            assert.strictEqual((await t.get(`/s/${plain}`)).status, 401, 'not public: sign in first');
            assert.strictEqual((await t.get(`/s/${plain}/download`)).status, 401);
        });

        await check('public and named accounts do not mix', async () => {
            const r = await share(t, kim, { file_id: file.id, public: true, usernames: ['lee'] });
            assert.strictEqual(r.status, 422);
            assert.strictEqual(r.json().code, 'share.invalid');
        });

        await check('a signed-out visitor can report a public link; three reports suspend it', async () => {
            const slug = (await share(t, kim, { file_id: file.id, public: true })).json().share.slug;
            const report = (ip) => t.get(`/s/${slug}/report`, { method: 'POST', form: { reason: 'other', note: '' }, headers: { ...SAME, 'x-forwarded-for': ip } });
            assert.strictEqual((await report('203.0.113.1')).status, 200);
            await report('203.0.113.1');
            await report('203.0.113.2');
            await t.get(`/s/${slug}/report`, { as: lee, method: 'POST', form: { reason: 'other', note: '' }, headers: SAME });
            assert.strictEqual((await t.get(`/s/${slug}/download`)).status, 403, 'suspended until staff look');
            const rows = await t.ctx.s.db.many('SELECT reporter FROM mh_reports WHERE slug = $1', [slug]);
            assert.strictEqual(rows.length, 3, 'one report per address or person');
            assert.ok(rows.every((x) => !x.reporter.includes('203.0.113')), 'addresses are never stored');
        });

        await check('free accounts: 25 GB, files up to 2 GB', () => {
            assert.strictEqual(t.config.quotas.bytes, 25 * 1024 ** 3);
            assert.strictEqual(t.config.quotas.maxFileBytes, 2 * 1024 ** 3);
        });

        await check('the share form offers the public option', async () => {
            const r = await t.get(`/files/${file.id}`, { as: kim });
            assert.ok(r.text.includes('name="who" value="public"') && r.text.includes('no account needed'));
            const made = await t.get(`/files/${file.id}/share`, { as: kim, method: 'POST', form: { who: 'public', hours: '72', usernames: '' }, headers: SAME });
            assert.strictEqual(made.status, 200);
            assert.ok(made.text.includes('no account needed'));
        });
    } finally { await t.close(); }
    done();
})().catch((e) => { console.error(e); process.exit(1); });
