'use strict';
/**
 * Drops (server/drive/drops.js, migration 0012): uploading to openvibe.download without an account, the owner's Q10.
 *   - off by default (plan T10's gate): the API answers 403 drop.off and /d/<slug> is a 404;
 *   - on: a session per token (not per address), parts, completion into an ownerless Media object, a public page with
 *     a download and a report form, and a delete key that works once;
 *   - per-address daily caps; reports suspend (illegal at once); a staff takedown blocklists the file's sha256 so the
 *     same bytes cannot come back; the sweep deletes drops nobody downloaded for the idle days.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { SAME, bytes, sha256 } = require('./helpers/drive');

const MB = 1024 * 1024;

async function drop(t, data, { name = 'notes.bin', token: tokenOverride = null } = {}) {
    const started = await t.get('/api/v1/drops', { json: { name, size: data.length, content_type: 'application/octet-stream' } });
    if (started.status !== 201) return { started };
    const { upload, token } = started.json();
    const useToken = tokenOverride || token;
    for (let n = 1; n <= upload.parts_expected; n++) {
        const slice = data.subarray((n - 1) * upload.part_size, Math.min(data.length, n * upload.part_size));
        const part = await t.get(`/api/v1/drops/${upload.id}/parts/${n}`, { method: 'PUT', body: slice, headers: { 'content-type': 'application/octet-stream', 'x-drop-token': useToken } });
        if (part.status !== 200) return { started, part };
    }
    const completed = await t.get(`/api/v1/drops/${upload.id}/complete`, { json: {}, headers: { 'x-drop-token': useToken } });
    return { started, completed };
}

(async () => {
    const off = await boot({ env: { MEDIAHUB_PART_BYTES: String(5 * MB) } });
    await check('off by default: the API refuses and there is no page', async () => {
        const r = await off.get('/api/v1/drops', { json: { name: 'x', size: 10 } });
        assert.strictEqual(r.status, 403);
        assert.strictEqual(r.json().code, 'drop.off');
        assert.strictEqual((await off.get('/d/abcdefghijklmnopqrstuvwx')).status, 404);
        assert.ok(!(await off.get('/')).text.includes('Upload without an account'));
    });
    await off.close();

    const t = await boot({
        env: {
            MEDIAHUB_DOWNLOAD_ANONYMOUS: '1', MEDIAHUB_PART_BYTES: String(5 * MB),
            MEDIAHUB_DROPS_PER_DAY: '3', MEDIAHUB_DROP_MAX_BYTES: String(12 * MB), MEDIAHUB_DROP_IDLE_DAYS: '30',
        },
    });
    const staff = t.network.addUser('mod', { role: 'admin' });
    let first = null;
    let deleteUrl = null;

    await check('a file goes up without an account: a token-held session, parts, a public page and a delete link', async () => {
        assert.ok((await t.get('/')).text.includes('Upload without an account'), 'the home page offers it signed out');
        const data = bytes(6 * MB + 77, 'drop-one');
        const wrong = await drop(t, data, { token: 'x'.repeat(32) });
        assert.strictEqual(wrong.part.status, 404, 'a part needs the session\'s own token');
        const out = await drop(t, data, { name: 'holiday.bin' });
        assert.strictEqual(out.completed.status, 201, out.completed.text);
        const j = out.completed.json();
        assert.match(j.drop.url, /\/d\/[A-Za-z0-9_-]{24}$/);
        assert.match(j.delete_url, /\/delete\?key=/);
        first = j.drop.slug;
        deleteUrl = new URL(j.delete_url).pathname + new URL(j.delete_url).search;
        const object = [...t.media.objects.values()].find((o) => o.size_bytes === data.length);
        assert.ok(object && object.owner_subject === null, 'an ownerless Media object');
        const pageResp = await t.get(`/d/${first}`);
        assert.strictEqual(pageResp.status, 200);
        assert.ok(pageResp.text.includes('holiday.bin') && pageResp.text.includes(`/d/${first}/download`) && pageResp.text.includes('Report this'));
        assert.ok(pageResp.text.includes('noindex'), 'never indexed');
        const dl = await t.get(`/d/${first}/download`);
        assert.strictEqual(dl.status, 200);
        assert.strictEqual(sha256(dl.buffer), sha256(data), 'the bytes round-trip');
        assert.match(String(dl.headers.get('content-disposition')), /attachment/);
        assert.ok((await t.get(`/d/${first}`)).text.includes('<td>1</td>'), 'downloads are counted');
    });

    await check('the per-address caps and the size cap hold', async () => {
        const big = await t.get('/api/v1/drops', { json: { name: 'big', size: 13 * MB } });
        assert.strictEqual(big.status, 413);
        assert.strictEqual((await drop(t, bytes(1000, 'two'))).completed.status, 201);
        assert.strictEqual((await drop(t, bytes(1000, 'three'))).completed.status, 201);
        const fourth = await t.get('/api/v1/drops', { json: { name: 'four', size: 10 } });
        assert.strictEqual(fourth.status, 429, 'three a day here');
        assert.strictEqual(fourth.json().code, 'file.daily_limit');
    });

    await check('a report of illegal content suspends it; staff take it down and the same bytes are refused', async () => {
        const reported = await t.get(`/d/${first}/report`, { form: { reason: 'illegal', note: 'bad' }, headers: SAME });
        assert.strictEqual(reported.status, 200);
        const suspended = await t.get(`/d/${first}`);
        assert.ok(suspended.text.includes('suspended') && !suspended.text.includes(`/d/${first}/download"`));
        assert.strictEqual((await t.get(`/d/${first}/download`)).status, 303);
        const queue = await t.get('/staff', { as: staff });
        assert.ok(queue.text.includes(`/d/${first}`), 'staff see it');
        assert.strictEqual((await t.get(`/staff/drops/${first}/remove`, { as: staff, form: {}, headers: SAME })).status, 303);
        assert.strictEqual((await t.get(`/d/${first}`)).status, 410);
    });

    await check('a blocklisted file cannot come back; the delete key works once; the sweep removes idle drops', async () => {
        await t.ctx.s.db.exec("UPDATE mh_drops SET created_at = '2000-01-01T00:00:00.000Z' WHERE state <> 'removed'");
        const again = await drop(t, bytes(6 * MB + 77, 'drop-one'));
        assert.strictEqual(again.completed.status, 451, again.completed.text);
        assert.strictEqual(again.completed.json().code, 'drop.blocked');

        const fresh = await drop(t, bytes(2000, 'deletable'));
        const j = fresh.completed.json();
        const del = new URL(j.delete_url);
        const confirmPage = await t.get(del.pathname + del.search);
        assert.ok(confirmPage.text.includes('Delete it for good'));
        assert.strictEqual((await t.get(`/d/${j.drop.slug}/delete`, { form: { key: 'nope' }, headers: SAME })).status, 403);
        assert.strictEqual((await t.get(`/d/${j.drop.slug}/delete`, { form: { key: del.searchParams.get('key') }, headers: SAME })).status, 200);
        assert.strictEqual((await t.get(`/d/${j.drop.slug}`)).status, 410);
        void deleteUrl;

        const idle = await drop(t, bytes(3000, 'idle'));
        const idleSlug = idle.completed.json().drop.slug;
        await t.ctx.s.db.exec("UPDATE mh_drops SET created_at = '2000-01-01T00:00:00.000Z' WHERE slug = $1", [idleSlug]);
        const swept = await t.ctx.drops.sweep();
        assert.ok(swept >= 1);
        assert.strictEqual((await t.get(`/d/${idleSlug}`)).status, 410);
    });

    await t.close();
    done();
})();
