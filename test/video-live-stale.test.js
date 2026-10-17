'use strict';
/**
 * OpenVibe.Video asks OpenVibe.Live for its pages' recordings (server/video/live-client.js). Live waits on OpenVibe.Media,
 * and Media stalls for seconds at times while it remuxes a live stream's DVR: production logged 23 "Live did not
 * answer" in 12 hours on 2026-10-16. A page then shows Live's last answer (up to 30 minutes old) instead of an error;
 * with nothing cached, or an answer older than that, it is still "OpenVibe.Live did not answer".
 *
 *   node test/video-live-stale.test.js
 */
const assert = require('assert');
const { createLiveClient, LiveUnavailableError } = require('../server/video/live-client');

(async () => {
    let now = Date.parse('2026-10-16T20:00:00Z');
    const realNow = Date.now;
    Date.now = () => now;
    let mode = 'ok';
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        if (mode === 'timeout') { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }
        if (mode === '502') return { ok: false, status: 502, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ items: [{ id: calls }] }) };
    };
    const warnings = [];
    const client = createLiveClient({ config: { video: { liveUrl: 'http://127.0.0.1:3000' } }, fetchImpl, log: { warn: (...a) => warnings.push(a.join(' ')) } });
    try {
        const first = await client.feed({ type: 'all', limit: 24 });
        assert.deepStrictEqual(first.items, [{ id: 1 }]);
        now += 10_000;
        assert.deepStrictEqual((await client.feed({ type: 'all', limit: 24 })).items, [{ id: 1 }], 'a fresh answer comes from the cache');
        assert.strictEqual(calls, 1);

        now += 5 * 60_000;
        mode = 'timeout';
        assert.deepStrictEqual((await client.feed({ type: 'all', limit: 24 })).items, [{ id: 1 }], 'Live timing out: the last answer');
        mode = '502';
        assert.deepStrictEqual((await client.feed({ type: 'all', limit: 24 })).items, [{ id: 1 }], 'Live failing: the last answer');
        assert.ok(warnings.every((w) => /serving its last answer/.test(w)), 'and the log says so');

        mode = 'ok';
        assert.deepStrictEqual((await client.feed({ type: 'all', limit: 24 })).items, [{ id: calls }], 'Live back: a new answer');

        now += 31 * 60_000;
        mode = 'timeout';
        await assert.rejects(client.feed({ type: 'all', limit: 24 }), LiveUnavailableError, 'an answer older than 30 minutes is not shown');
        await assert.rejects(client.feed({ type: 'video', limit: 12 }), LiveUnavailableError, 'nothing cached: the error as before');
    } finally {
        Date.now = realNow;
    }
    console.log('video live stale: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
