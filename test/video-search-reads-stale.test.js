'use strict';
/**
 * OpenVibe.Video reads its shelves and searches from OpenVibe.Search (server/video/search-reads.js), cached five
 * minutes. Past that, an answer under an hour old is served at once and refreshed behind the page, one refresh per URL,
 * so a visitor no longer waits for Search; an older one is fetched while they wait, and when Search fails the last
 * answer still beats an empty shelf.
 *
 *   node test/video-search-reads-stale.test.js
 */
const assert = require('assert');
const { createSearchReads } = require('../server/video/search-reads');

(async () => {
    let now = Date.parse('2026-11-02T14:00:00Z');
    const realNow = Date.now;
    Date.now = () => now;
    let calls = 0;
    let fail = false;
    const fetchImpl = async () => {
        calls++;
        if (fail) return { ok: false, status: 503, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ results: [], facets: {}, n: calls }) };
    };
    const reads = createSearchReads({ config: { search: { url: 'http://127.0.0.1:4710' } }, fetchImpl, log: { warn() {} } });
    const ask = () => reads.search('robot', { kind: 'vod' });
    try {
        await ask();
        assert.strictEqual(calls, 1);
        now += 60_000;
        await ask();
        assert.strictEqual(calls, 1, 'fresh for five minutes');

        now += 10 * 60_000;
        const answers = await Promise.all([ask(), ask(), ask()]);
        assert.ok(answers.every((a) => a && a.items), 'past five minutes three readers get the last answer at once…');
        await reads.settled();
        assert.strictEqual(calls, 2, '…and one refresh runs behind the page for all three');
        await ask();
        assert.strictEqual(calls, 2, 'the refreshed answer is fresh again');

        now += 10 * 60_000;
        fail = true;
        await ask();
        await reads.settled();
        await ask();
        assert.ok(calls >= 3, 'a failed refresh is tried again later');

        now += 2 * 60 * 60_000;
        fail = false;
        const before = calls;
        await ask();
        assert.strictEqual(calls, before + 1, 'older than an hour: fetched while the visitor waits');
    } finally {
        Date.now = realNow;
    }
    console.log('video search reads stale: all checks passed');
})().catch((err) => { console.error(err); process.exit(1); });
