'use strict';
/**
 * Studio's trim, end to end: a real 6-second MP4 becomes a cut of 1.00–4.00 s through the existing
 * cuts worker and ffmpeg, and the chosen frame becomes the copy's cover through Media's thumbnail
 * route. The copy's duration is checked against the range (within one second), and a range under
 * one second or outside the video is refused with a plain sentence.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function makeVideo(file) {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=6',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', file]);
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    return fs.readFileSync(file);
}

function probe(buf) {
    const file = path.join(os.tmpdir(), `ov-trim-probe-${process.pid}-${Date.now()}.mp4`);
    fs.writeFileSync(file, buf);
    try {
        const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
        const j = JSON.parse(String(r.stdout));
        return { duration: Number(j.format.duration), video: j.streams.some((x) => x.codec_type === 'video'), audio: j.streams.some((x) => x.codec_type === 'audio') };
    } finally { fs.rmSync(file, { force: true }); }
}

function vreq(base, p, { method = 'GET', bearer, json } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(base + p);
        const headers = { Host: 'openvibe.video' };
        if (bearer) headers.authorization = `Bearer ${bearer}`;
        if (method !== 'GET') headers['sec-fetch-site'] = 'same-origin';
        let body;
        if (json !== undefined) { body = Buffer.from(JSON.stringify(json)); headers['content-type'] = 'application/json'; headers['content-length'] = body.length; }
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

(async () => {
    if (!HAVE_FFMPEG) {
        process.stdout.write('  - ffmpeg is not installed here: the end-to-end trim is skipped\n');
        return done();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-trim-'));
    const t = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', VIDEO_CUTS_NICE: '0', MEDIAHUB_MEDIA_PUBLIC_URL: 'https://openvibe.media' } });
    const kim = t.network.addUser('kim');
    const token = t.network.userToken(kim);
    const owner = `user:${kim.subject}`;
    try {
        const bytes = makeVideo(path.join(dir, 'source.mp4'));
        const duration = probe(bytes).duration;
        t.media.vods.set(950, { id: 950, title: 'Six seconds', visibility: 'private', bytes, types: ['video/mp4'], status: 'ready', watch_id: 'sixsecs0001' });
        await t.ctx.s.db.query(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at, duration_seconds, watch_id)
                                VALUES ($1, $2, 'kim', 'Six seconds', 'For the trim.', 'private', 950, 'video/mp4', $3, 1000, 1, 1, 'ready', 'active', $4, $4, $4, $5, 'sixsecs0001')`,
        ['vup_01J0000000000000000000000A', owner, bytes.length, t.ctx.s.iso(), duration]);

        await check('the range is checked before a cut is queued', async () => {
            const short = await vreq(t.base, '/api/v1/video/studio/publish', { method: 'POST', bearer: token, json: { media: 'vup_01J0000000000000000000000A', start: 1, end: 1.4 } });
            assert.strictEqual(short.status, 422, short.text);
            assert.match(short.json().detail, /at least one second/i);
            const outside = await vreq(t.base, '/api/v1/video/studio/publish', { method: 'POST', bearer: token, json: { media: 'vup_01J0000000000000000000000A', start: 2, end: 99 } });
            assert.strictEqual(outside.status, 422, outside.text);
            assert.match(outside.json().detail, /inside the video/i);
            assert.strictEqual(Number(await t.ctx.s.db.value("SELECT count(*) FROM video_cuts WHERE upload_id = 'vup_01J0000000000000000000000A'")), 0);
        });

        await check('a real trim becomes a copy of the chosen duration, with the chosen cover', async () => {
            const start = 1;
            const end = 4;
            const publish = await vreq(t.base, '/api/v1/video/studio/publish', { method: 'POST', bearer: token, json: {
                media: 'vup_01J0000000000000000000000A', start, end, cover: 2.5, title: 'Studio trim', visibility: 'unlisted',
            } });
            assert.strictEqual(publish.status, 202, publish.text);
            const cutId = publish.json().cut.id;
            await t.ctx.videoCuts.sweep();
            const status = await vreq(t.base, `/api/v1/video/studio/cuts/${cutId}`, { bearer: token });
            assert.strictEqual(status.status, 200, status.text);
            const cut = status.json().cut;
            assert.strictEqual(cut.status, 'done', JSON.stringify(cut));
            assert.ok(cut.result && /^vup_/.test(cut.result.id));
            const copy = await t.ctx.videoUploads.byId(cut.result.id);
            assert.deepStrictEqual([copy.title, copy.visibility, copy.edited_from], ['Studio trim', 'unlisted', 'vup_01J0000000000000000000000A']);
            const vod = t.media.vods.get(Number(copy.media_vod_id));
            const out = probe(vod.bytes);
            assert.ok(out.video && out.audio, 'picture and sound');
            assert.ok(Math.abs(out.duration - (end - start)) <= 1, `the copy is ${out.duration} s for a ${end - start} s range`);
            assert.match(copy.thumbnail_url || '', /^https:\/\/openvibe\.media\/t\//, 'the chosen frame is the cover');
            assert.ok(vod.coverBytes && vod.coverBytes.length > 100 && vod.coverBytes[0] === 0xff && vod.coverBytes[1] === 0xd8, 'Media received a JPEG cover');
        });
    } finally {
        await t.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
