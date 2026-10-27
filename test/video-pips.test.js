'use strict';
/**
 * Picture-in-picture over a recording (owner, 2026-10-26: "the VODs system should support and handle the PIPs a streamer
 * had configured during that vod"). Live answers a VOD's `pips` (OpenVibe.Live streaming/pip-history.js): each its own
 * VOD, its window in this one (from, to), that VOD's second at `from`, where it started and whether it had sound. The
 * watch page hands public/js/video.js each PIP's file and playlist (from Live's answer for that VOD), and video.js plays
 * it over the player, synced to it.
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

function startLive() {
    const vods = {
        800: { id: 800, stream_id: 900, title: 'Screen share', duration_seconds: 600, created_at: '2026-10-27T10:00:00.000Z',
            playback_url: 'https://openvibe.media/v/800', file_url: 'https://openvibe.media/v/800', visibility: 'public', username: 'host', display_name: 'Host',
            pips: [
                { vod_id: 801, title: 'Webcam', username: 'host', from: 20, to: 120, offset: 0, x: 0.73, y: 0.7, w: 0.25, muted: true },
                { vod_id: 802, title: 'Co-host </script><b>', username: 'cohost', from: 60, to: 300, offset: 42.5, x: 0.02, y: 0.02, w: 0.18, muted: false },
                { vod_id: 803, title: 'Gone', from: 10, to: 20, offset: 0 },
                { vod_id: 'x', from: 1, to: 2 },
                { vod_id: 801, title: 'Backwards', from: 50, to: 40, offset: 0 },
            ] },
        801: { id: 801, title: 'Webcam', duration_seconds: 200, playback_url: 'https://openvibe.media/v/801', file_url: 'https://openvibe.media/v/801',
            hls_url: 'https://openvibe.media/o/med_801/master.m3u8', visibility: 'public', username: 'host' },
        802: { id: 802, title: 'Co-host', duration_seconds: 900, playback_url: 'https://openvibe.media/v/802', file_url: 'https://openvibe.media/v/802',
            hls_url: 'https://evil.example/o/med_802/master.m3u8', visibility: 'public', username: 'cohost' },
        810: { id: 810, title: 'No PIPs', duration_seconds: 60, playback_url: 'https://openvibe.media/v/810', file_url: 'https://openvibe.media/v/810', visibility: 'public', username: 'host' },
    };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
        const v = /^\/api\/vods\/(\d+)$/.exec(url.pathname);
        if (v) return vods[v[1]] ? json(200, { vod: vods[v[1]], clips: [] }) : json(404, { error: 'not found' });
        return json(404, { error: 'not found' });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })));
}

const get = (base, p) => new Promise((resolve, reject) => {
    const u = new URL(base + p);
    http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { Host: 'openvibe.video' } }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
});

(async () => {
    const live = await startLive();
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', MEDIAHUB_LIVE_URL: live.url, MEDIAHUB_LIVE_PUBLIC_URL: 'https://openvibe.live' } });

    await check("the watch page hands the player each PIP: its VOD's file and playlist, its window, its offset, its place", async () => {
        const r = await get(t.base, '/v/800');
        assert.strictEqual(r.status, 200);
        const m = /<script type="application\/json" data-ovv-pips>([^<]*)<\/script>/.exec(r.text);
        assert.ok(m, 'the PIP data rides in the player');
        assert.ok(r.text.indexOf('data-ovv-pips') > r.text.indexOf('data-ovv-video') && r.text.indexOf('data-ovv-pips') < r.text.indexOf('<h1'), 'inside the player wrap');
        const pips = JSON.parse(m[1]);
        assert.deepStrictEqual(pips.map((p) => [p.file, p.hls, p.from, p.to, p.offset, p.x, p.w, p.muted, p.href]), [
            ['https://openvibe.media/v/801', 'https://openvibe.media/o/med_801/master.m3u8', 20, 120, 0, 0.73, 0.25, true, '/v/801'],
            ['https://openvibe.media/v/802', null, 60, 300, 42.5, 0.02, 0.18, false, '/v/802?t=42'],
        ], "a PIP whose VOD Live does not answer, a bad id and a backwards window are left out; a playlist on another origin than the file is not used");
        assert.strictEqual(pips[1].title, 'Co-host </script><b>', 'the title arrives as it is');
        assert.ok(!m[1].includes('</script>') && m[1].includes('\\u003c/script>'), 'and never closes the data block early');
    });

    await check('a recording without PIPs carries no PIP data', async () => {
        const r = await get(t.base, '/v/810');
        assert.strictEqual(r.status, 200);
        assert.ok(!r.text.includes('data-ovv-pips'));
    });

    await check('video.js plays each PIP over the player, synced to it, and lets a viewer move, resize, mute and hide it', async () => {
        const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'video.js'), 'utf8');
        assert.ok(/if \(t != null\) seek\(video, t\);\n\s+pips\(video\);/.test(js), 'started once the main video has its source');
        assert.ok(js.includes("const root = video.closest('.ov-player') || video.parentNode;"), 'inside the shared player (full screen with it)');
        assert.ok(js.includes('const on = t >= p.from && t < p.to && !it.g.hidden;') && js.includes('const want = p.offset + (t - p.from);'), 'shown in its window at offset + (t - from)');
        assert.ok(js.includes("video.addEventListener('seeked', function () { sync(true); });"), 'a seek moves it');
        assert.ok(js.includes('if (t >= p.from - 15 && t < p.to) load(it);'), 'its file loads only when its moment comes near');
        assert.ok(js.includes('attachSource(it.v);'), 'its playlist plays the way the main one does');
        assert.ok(js.includes("box.addEventListener('click', function (e) { e.stopPropagation(); });"), 'a click on it never plays or pauses the video');
        assert.ok(js.includes("const key = 'ovv-pip-' + window.location.pathname;"), 'where a viewer put it is remembered for this recording');
        const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'video.css'), 'utf8');
        assert.ok(/\.ovv-pip \{ position: absolute; z-index: 2;/.test(css), 'above the picture, under the controls (3)');
    });

    await t.close();
    await live.close();
    done();
})();
