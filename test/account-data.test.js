'use strict';
/**
 * Account export and deletion (ADR-033), through openvibe-sdk/account-data: Network asks for a person's rows, and
 * later tells this service they are gone. Deleting also asks OpenVibe.Media to delete each object the person held.
 *
 * The events arrive signed on POST /internal/events — a route that refuses anything that came through a proxy, so
 * only loopback can reach it even though nginx proxies the path. The stand-in Network records the part it was given
 * and the confirmation it was sent (test/helpers/mocks.js).
 */
const assert = require('assert');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, upload, share } = require('./helpers/drive');

const SECRET = 'm'.repeat(48);
const EXPORT = 'exp_01JABCDEFGHJKMNPQRSTVWXYZ0';
const DELETION = 'del_01JABCDEFGHJKMNPQRSTVWXYZ0';

(async () => {
    const t = await boot({ env: { MEDIAHUB_EVENTS_SECRET: SECRET } });
    const kim = t.network.addUser('kim');
    const sam = t.network.addUser('sam');

    const file = (await upload(t, kim, bytes(300, 'kim'), { name: 'kim.bin' })).json().file;
    const slug = (await share(t, kim, { file_id: file.id, hours: 24 })).json().share.slug;
    await t.get(`/s/${slug}/report`, { as: sam, form: { reason: 'malware', note: 'nope' }, headers: SAME });
    const sams = (await upload(t, sam, bytes(300, 'sam'), { name: 'sam.bin' })).json().file;
    // And kim files one against sam's file, so each has a report of their own in the export.
    const samSlug = (await share(t, sam, { file_id: sams.id, hours: 24 })).json().share.slug;
    await t.get(`/s/${samSlug}/report`, { as: kim, form: { reason: 'other', note: 'kim says' }, headers: SAME });

    const deliver = (event) => {
        const body = Buffer.from(JSON.stringify({ event }));
        return t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET) } });
    };
    const envelope = (type, payload) => ({ event_id: `evt_${Math.random().toString(16).slice(2)}`, event_type: type, source: 'network', at: new Date().toISOString(), payload });

    await check('the events route takes a signed delivery, and nothing else', async () => {
        const event = envelope('network.account.export_requested', { export_id: EXPORT, subject: kim.subject });
        const body = Buffer.from(JSON.stringify({ event }));
        const unsigned = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
        assert.strictEqual(unsigned.status, 401);
        const wrongKey = await t.get('/internal/events', { method: 'POST', body, headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, 'w'.repeat(48)) } });
        assert.strictEqual(wrongKey.status, 401);
        const proxied = await t.get('/internal/events', {
            method: 'POST', body,
            headers: { 'content-type': 'application/json', ...signDeliveryHeaders(body, SECRET), 'x-forwarded-for': '203.0.113.9' },
        });
        assert.strictEqual(proxied.status, 403, 'a request through a proxy is not Network');
        assert.strictEqual((await t.get('/internal/events', { method: 'GET' })).status, 405);
    });

    await check('the export carries the person\'s files, folders, shares, reports and upload counts', async () => {
        const r = await deliver(envelope('network.account.export_requested', { export_id: EXPORT, subject: kim.subject }));
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.strictEqual(r.json().outcome, 'exported');
        assert.strictEqual(t.network.accountParts.length, 1, 'Network was given the part');
        const part = t.network.accountParts[0].body;
        assert.strictEqual(part.subject, kim.subject);
        const files = part.files.find((f) => f.name === 'files.json');
        assert.ok(files, 'a files.json part');
        assert.strictEqual(files.content.length, 1);
        assert.strictEqual(files.content[0].id, file.id);
        assert.deepStrictEqual(part.files.map((f) => f.name).sort(), ['files.json', 'reports.json', 'shares.json', 'usage.json'], 'and the rest of the person\'s own data');
        assert.ok(part.files.find((f) => f.name === 'shares.json').content.some((s) => s.slug === slug));
        assert.strictEqual(part.files.find((f) => f.name === 'reports.json').content.length, 1, 'the report kim filed');
        assert.ok(!JSON.stringify(part).includes(sams.id), 'nothing of sam\'s');

        // The same delivery again changes nothing: it is idempotent per export id.
        assert.strictEqual((await deliver(envelope('network.account.export_requested', { export_id: EXPORT, subject: kim.subject }))).json().outcome, 'unchanged');
        assert.strictEqual(t.network.accountParts.length, 1);
    });

    await check('a deletion erases the rows and asks Media to delete each object', async () => {
        const before = t.media.deleted.length;
        const r = await deliver(envelope('network.account.deleted', { deletion_id: DELETION, subject: kim.subject }));
        assert.strictEqual(r.status, 200, r.text.slice(0, 300));
        assert.strictEqual(r.json().outcome, 'erased');

        assert.strictEqual((await t.get('/api/v1/files', { as: kim })).json().files.length, 0, 'kim has no files');
        assert.strictEqual((await t.get(`/s/${slug}`, { as: sam })).status, 404, 'and no share links');
        assert.deepStrictEqual(t.media.deleted.slice(before), [file.object.media_object_id], 'Media was asked for exactly kim\'s object');

        assert.strictEqual(t.network.accountConfirmations.length, 1, 'Network was confirmed');
        const confirmation = t.network.accountConfirmations[0].body;
        assert.strictEqual(confirmation.subject, kim.subject);
        assert.ok(confirmation.erased.mh_files >= 1, JSON.stringify(confirmation));
        assert.ok(confirmation.erased.mh_shares >= 1, JSON.stringify(confirmation));

        // Sam's drive is untouched.
        assert.strictEqual((await t.get(`/api/v1/files/${sams.id}`, { as: sam })).status, 200);
        assert.deepStrictEqual(t.media.bytesOf(sams.object.media_object_id), bytes(300, 'sam'), 'and his bytes are still in Media');
    });

    await check('a redelivered deletion erases nothing twice', async () => {
        const before = t.media.deleted.length;
        const again = await deliver(envelope('network.account.deleted', { deletion_id: DELETION, subject: kim.subject }));
        assert.strictEqual(again.status, 200);
        assert.strictEqual(t.media.deleted.length, before, 'Media is not asked again');
        assert.strictEqual(t.network.accountConfirmations.length, 1, 'and no second confirmation is sent');
    });

    await check('an event this service does not handle is acknowledged and ignored', async () => {
        const r = await deliver(envelope('network.something.else', {}));
        assert.strictEqual(r.status, 200);
        assert.match(r.json().outcome, /^ignored/);
    });

    await check('another service\'s event source is not accepted as Network\'s', async () => {
        const event = { ...envelope('network.account.deleted', { deletion_id: 'del_01JABCDEFGHJKMNPQRSTVWXYZ1', subject: sam.subject }), source: 'live' };
        const r = await deliver(event);
        assert.strictEqual(r.status, 200);
        assert.match(r.json().outcome, /^ignored/);
        assert.strictEqual((await t.get(`/api/v1/files/${sams.id}`, { as: sam })).status, 200, 'and sam still has his file');
    });

    await t.close();
    done();
})().catch((e) => { console.error(e); process.exit(1); });
