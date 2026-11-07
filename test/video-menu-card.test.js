'use strict';
// The menu's network card for OpenVibe.Video (frame.menu-card@1): GET /.well-known/openvibe-menu.json serves the
// week's most viewed public recordings and clips from Live's Content feed, CORS *, cached two minutes.
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { createMenuCardHandler, cardFrom, imageOf, plain, CARD_TTL_S } = require('../server/video/menu-card');

const vod = (id, views, title = `Recording ${id}`) => ({ kind: 'vod', id, title, views });
const clip = (id, views, title = `Clip ${id}`) => ({ kind: 'clip', id, title, views });

// ── The card's shape, order and words ──────────────────────────────────
const card = cardFrom([vod(1, 120), clip(2, 900), vod(3, 30)], Date.parse('2026-11-07T08:00:00Z'));
assert.deepStrictEqual(Object.keys(card).sort(), ['id', 'items', 'kind', 'more', 'site', 'title', 'ttl_s', 'updated_at']);
assert.strictEqual(card.id, 'trending');
assert.strictEqual(card.site, 'media-hub');
assert.strictEqual(card.title, 'Trending');
assert.strictEqual(card.kind, 'rows');
assert.strictEqual(card.ttl_s, 300);
assert.strictEqual(card.updated_at, '2026-11-07T08:00:00.000Z');
assert.deepStrictEqual(card.items, [
    { title: 'Clip 2', meta: '900 views this week', url: 'https://openvibe.video/c/2' },
    { title: 'Recording 1', meta: '120 views this week', url: 'https://openvibe.video/v/1' },
    { title: 'Recording 3', meta: '30 views this week', url: 'https://openvibe.video/v/3' },
]);
assert.deepStrictEqual(card.more, { label: 'Watch more', url: 'https://openvibe.video/' });
assert.ok(contracts.validate('frame.menu-cards@1', [card]).valid, 'the file validates against frame.menu-cards@1');
for (const item of card.items) {
    assert.ok(item.title.length <= 80 && item.meta.length <= 120);
    assert.ok(item.url.startsWith('https://openvibe.video/'));
}

// Pictures: the item's own Media thumbnail at 640 px and 640x360; a real picture only, never a placeholder.
const pictured = cardFrom([
    vod(1, 30),
    { kind: 'clip', id: 2, title: 'Clip 2', views: 20, thumbnail_url: 'https://openvibe.media/t/clip-2-1.jpg' },
    { kind: 'vod', id: 3, title: 'Elsewhere', views: 10, thumbnail_url: 'https://www.youtube.com/i/x.jpg' },
    { kind: 'vod', id: 4, title: 'Plain http', views: 5, thumbnail_url: 'http://openvibe.media/t/vod-4-1.jpg' },
    { kind: 'vod', id: 5, title: 'Own origin', views: 1, thumbnail_url: 'https://openvibe.video/live/nova/frame.jpg' },
]);
assert.deepStrictEqual(pictured.items[0], { title: 'Recording 1', meta: '30 views this week', url: 'https://openvibe.video/v/1' }, 'no picture: no image key');
assert.deepStrictEqual(pictured.items[1].image, { src: 'https://openvibe.media/t/clip-2-1.jpg?w=640&fmt=webp', w: 640, h: 360 });
assert.ok(!pictured.items[2].image && !pictured.items[3].image, 'a third-party or plain-http picture is left out');
assert.deepStrictEqual(pictured.items[4].image, { src: 'https://openvibe.video/live/nova/frame.jpg' }, 'another allowed host is used as it is');
assert.ok(contracts.validate('frame.menu-cards@1', [pictured]).valid, 'a pictured file validates against frame.menu-cards@1');
assert.strictEqual(imageOf({ thumbnail_url: 'https://openvibe.media/t/x.jpg?w=480' }).src, 'https://openvibe.media/t/x.jpg?w=480', 'an already-sized thumbnail is not re-queried');

// At most six, one view is singular, a repeated item appears once, and anything that is not a public VOD/clip is dropped.
assert.strictEqual(cardFrom(Array.from({ length: 8 }, (_, i) => vod(i + 1, 100 - i))).items.length, 6);
assert.strictEqual(cardFrom([clip(1, 1)]).items[0].meta, '1 view this week');
assert.strictEqual(cardFrom([vod(1, 5), vod(1, 9)]).items.length, 1);
assert.deepStrictEqual(cardFrom([{ kind: 'paste', id: 3, views: 99 }, vod(0, 4), vod('x', 4)]).items, []);
assert.deepStrictEqual(cardFrom([]).items, []);
assert.strictEqual(plain('<b>Sunday</b>\n\t market ', 80), 'Sunday market');
assert.strictEqual(plain('x'.repeat(200), 80).length, 80);

// ── The route: CORS *, 60 s browser cache, the two-minute card cache ──
function fakeRes() {
    const headers = {};
    let status = 200;
    let body = null;
    const res = {
        set(k, v) { headers[k] = v; return this; },
        status(n) { status = n; return this; },
        json(v) { body = v; return this; },
    };
    return { res, headers, status: () => status, body: () => body };
}

(async () => {
    let t = 1000;
    let calls = 0;
    const feed = async ({ type, limit, sort, window }) => {
        calls++;
        assert.strictEqual(limit, 6);
        assert.strictEqual(sort, 'top');
        assert.strictEqual(window, 'week');
        return { items: type === 'vods' ? [vod(1, 40)] : [clip(2, 80)] };
    };
    const handler = createMenuCardHandler({ feed, now: () => t });

    const first = fakeRes();
    await handler({}, first.res);
    assert.strictEqual(first.status(), 200);
    assert.strictEqual(first.headers['Access-Control-Allow-Origin'], '*');
    assert.strictEqual(first.headers['Cache-Control'], 'public, max-age=60');
    assert.ok(Array.isArray(first.body()) && first.body().length === 1, 'the file is an array of cards');
    assert.strictEqual(first.body()[0].site, 'media-hub');
    assert.deepStrictEqual(first.body()[0].items.map((x) => x.url), ['https://openvibe.video/c/2', 'https://openvibe.video/v/1']);
    assert.strictEqual(calls, 2, 'one feed call for VODs and one for clips');

    const second = fakeRes();
    await handler({}, second.res);
    assert.strictEqual(calls, 2, 'a second request inside the ttl is served from the card cache');
    t += CARD_TTL_S * 1000 + 1;
    await handler({}, fakeRes().res);

    // One feed failing still serves the other; both failing keeps the last good card.
    const oneDown = createMenuCardHandler({
        feed: async ({ type }) => (type === 'clips' ? { items: [clip(2, 80)] } : Promise.reject(new Error('down'))),
        now: () => t,
    });
    const half = fakeRes();
    await oneDown({}, half.res);
    assert.strictEqual(half.status(), 200);
    assert.deepStrictEqual(half.body()[0].items.map((x) => x.url), ['https://openvibe.video/c/2']);

    let fail = false;
    let buildCalls = 0;
    const flaky = createMenuCardHandler({
        feed: async () => {
            buildCalls++;
            if (fail) throw new Error('down');
            return { items: [vod(1, 40)] };
        },
        now: () => t,
    });
    const good = fakeRes();
    await flaky({}, good.res);
    assert.strictEqual(good.status(), 200);
    fail = true;
    const kept = fakeRes();
    await flaky({}, kept.res);
    assert.strictEqual(kept.status(), 200);
    assert.strictEqual(kept.body()[0].items[0].url, 'https://openvibe.video/v/1');

    const never = createMenuCardHandler({ feed: async () => { throw new Error('down'); }, now: () => t });
    const none = fakeRes();
    await never({}, none.res);
    assert.strictEqual(none.status(), 503);
    assert.strictEqual(none.body().error, 'menu_unavailable');

    console.log('video menu card: rows, week views, merge, cache, CORS, one source down and no card');
})().catch((err) => { console.error(err); process.exit(1); });
