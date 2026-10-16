'use strict';
/**
 * The AI cut of an OpenVibe.Video upload (server/video/cut.js): the plans (pauses → kept ranges, the AI's highlights →
 * a reel), then the real thing with ffmpeg against the stand-in Media: the pause in a 14-second video is found and cut,
 * and the edited copy arrives as a new private upload of the owner's, pointing at its original. Only the owner may cut;
 * one cut at a time; a copy is not cut again; a video with no sound has no pauses; a restart retries a cut once.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { boot, check, done } = require('./helpers/boot');
const { planPauses, planHighlights, parseSilence, filterGraph } = require('../server/video/cut');

/** A request with Host: openvibe.video (Node's fetch drops a Host header): t.get's options, the same answer shape. */
function videoClient(t) {
    return (p, o = {}) => new Promise((resolve, reject) => {
        const http = require('http');
        const headers = { ...(o.headers || {}) };
        if (o.as) headers.cookie = t.signIn(o.as);
        let body = null;
        if (o.json !== undefined) { body = Buffer.from(JSON.stringify(o.json)); headers['content-type'] = 'application/json'; }
        if (o.form !== undefined) { body = Buffer.from(new URLSearchParams(o.form).toString()); headers['content-type'] = 'application/x-www-form-urlencoded'; }
        if (body) headers['content-length'] = String(body.length);
        const u = new URL(t.base + p);
        const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: o.method || (body ? 'POST' : 'GET'), headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

const HAVE_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

function makeVideo(file, { audio = true } = {}) {
    // 14 s: a tone, five seconds of silence (4–9 s), the tone again.
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=14'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=14', '-af', "volume=enable='between(t,4,9)':volume=0", '-c:a', 'aac');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file);
    const r = spawnSync('ffmpeg', args);
    if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
    return fs.readFileSync(file);
}

function probe(buf) {
    const file = path.join(os.tmpdir(), `ov-cut-probe-${process.pid}-${Date.now()}.mp4`);
    fs.writeFileSync(file, buf);
    try {
        const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
        const j = JSON.parse(String(r.stdout));
        return { duration: Number(j.format.duration), video: j.streams.some((x) => x.codec_type === 'video'), audio: j.streams.some((x) => x.codec_type === 'audio') };
    } finally { fs.rmSync(file, { force: true }); }
}

(async () => {
    await check('silencedetect lines → spans; one still open at the end runs to the end', () => {
        const text = '[silencedetect @ 0x1] silence_start: 4.02\n[silencedetect @ 0x1] silence_end: 9.01 | silence_duration: 4.99\nframe=1\n[silencedetect @ 0x1] silence_start: 20.5\n';
        assert.deepStrictEqual(parseSilence(text, 25), [{ start: 4.02, end: 9.01 }, { start: 20.5, end: 25 }]);
    });

    await check('pauses: a long pause keeps a quarter second each side; lead-in and tail go; short pauses stay; nothing to cut is null', () => {
        const plan = planPauses([{ start: 0, end: 2 }, { start: 10, end: 14 }, { start: 20, end: 21 }, { start: 28, end: 30 }], 30, 'pauses');
        assert.deepStrictEqual(plan.ranges, [[1.75, 10.25], [13.75, 28.25]]);
        assert.strictEqual(plan.removed_count, 3);
        assert.strictEqual(plan.kept_seconds, 23);
        assert.strictEqual(planPauses([{ start: 5, end: 6 }], 30, 'pauses'), null, 'a one-second pause is not cut');
        assert.strictEqual(planPauses([{ start: 5, end: 6 }], 30, 'tight').removed_count, 1, 'but tight cuts it');
        assert.strictEqual(planPauses([], 30), null);
    });

    await check('highlights: the best six in time order, overlaps merged; old AI edits fall back to chapter starts', () => {
        const ai = { status: 'done', highlights: [{ start: 100, end: 130, score: 0.9 }, { start: 10, end: 40, score: 0.5 }, { start: 120, end: 150, score: 0.7 }, { start: 300, end: 330, score: 0.1 }] };
        assert.deepStrictEqual(planHighlights(ai, 600).ranges, [[10, 40], [100, 150], [300, 330]]);
        const old = { status: 'done', highlights: null, chapters: [{ start: 0, title: 'Start' }, { start: 60, title: 'A' }, { start: 200, title: 'B' }] };
        assert.deepStrictEqual(planHighlights(old, 600).ranges, [[60, 90], [200, 230]]);
        assert.strictEqual(planHighlights({ status: 'done', highlights: [{ start: 1, end: 30, score: 1 }] }, 600), null, 'one moment is not a reel');
        assert.strictEqual(planHighlights({ status: 'running' }, 600), null);
    });

    await check('the filter graph trims each range and concatenates them (no audio: video only)', () => {
        const g = filterGraph([[0, 2], [5, 7]]);
        assert.ok(g.includes('[0:v:0]trim=start=5:end=7,setpts=PTS-STARTPTS[v1]') && g.includes('[0:a:0]atrim=start=0:end=2'));
        assert.ok(g.includes('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vc][ac]'));
        assert.ok(!filterGraph([[0, 2], [5, 7]], { audio: false }).includes('atrim'));
    });

    if (!HAVE_FFMPEG) {
        console.log('  - ffmpeg is not installed here: the end-to-end cut is skipped');
        return done();
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-cut-'));
    const t0 = await boot({ env: { MEDIAHUB_VIDEO_URL: 'https://openvibe.video', VIDEO_CUTS_NICE: '0' } });
    const t = { ...t0, get: videoClient(t0) };
    const s = t.ctx.s;
    const V = { Host: 'openvibe.video', 'sec-fetch-site': 'same-origin' };
    try {
        const kim = t.network.addUser('kim');
        const lee = t.network.addUser('lee');
        const owner = `user:${kim.subject}`;
        const addVod = (id, bytes) => t.media.vods.set(id, { id, title: 'x', visibility: 'private', bytes, types: ['video/mp4'], status: 'ready' });
        const addUpload = async (id, vodId, o = {}) => {
            await s.db.exec(`INSERT INTO video_uploads (id, owner, owner_username, title, description, visibility, media_vod_id, content_type, size_bytes, part_size, parts_expected, parts_received, status, state, created_at, updated_at, ready_at, duration_seconds)
                             VALUES ($1, $2, 'kim', $3, 'About the tone.', 'public', $4, 'video/mp4', 1000, 1000, 1, 1, 'ready', 'active', $5, $5, $5, 14)`,
            [id, owner, o.title || 'A tone and a pause', vodId, s.iso()]);
        };
        addVod(900, makeVideo(path.join(dir, 'a.mp4')));
        addVod(901, makeVideo(path.join(dir, 'b.mp4'), { audio: false }));
        const A = 'vup_01J0000000000000000000000A';
        const B = 'vup_01J0000000000000000000000B';
        await addUpload(A, 900);
        await addUpload(B, 901, { title: 'No sound' });

        await check('the owner sees the AI edit panel; anyone else does not, and cannot start a cut', async () => {
            const mine = await t.get(`/u/${A}`, { as: kim, headers: V });
            assert.ok(mine.text.includes('AI edit') && mine.text.includes('Cut the pauses') && !mine.text.includes('Highlights reel'), 'no reel without the AI edit');
            assert.ok(!(await t.get(`/u/${A}`, { as: lee, headers: V })).text.includes('AI edit'));
            assert.strictEqual((await t.get(`/u/${A}/cut`, { as: lee, form: { mode: 'pauses' }, headers: V })).status, 404);
        });

        let copyId;
        await check('pauses: the five-second pause is found and cut; the copy is a new private upload pointing at its original', async () => {
            const r = await t.get(`/u/${A}/cut`, { as: kim, form: { mode: 'pauses' }, headers: V });
            assert.strictEqual(r.status, 303);
            const again = await t.get(`/api/v1/videos/${A}/cuts`, { as: kim, method: 'POST', json: { mode: 'tight' }, headers: V });
            assert.deepStrictEqual([again.status, again.json().code], [409, 'cut.busy'], 'one at a time');
            await t.ctx.videoCuts.sweep();
            const cut = (await t.get(`/api/v1/videos/${A}/cuts`, { as: kim, headers: V })).json().cuts[0];
            assert.strictEqual(cut.status, 'done', JSON.stringify(cut));
            assert.strictEqual(cut.removed_count, 1);
            assert.ok(Math.abs(cut.kept_seconds - 9.5) < 0.6, `kept ${cut.kept_seconds}`);
            copyId = cut.result.id;
            const copy = await s.db.maybe('SELECT * FROM video_uploads WHERE id = $1', [copyId]);
            assert.deepStrictEqual([copy.owner, copy.visibility, copy.edited_from, copy.title], [owner, 'private', A, 'A tone and a pause (pauses cut)']);
            const bytes = t.media.vods.get(Number(copy.media_vod_id)).bytes;
            const p = probe(bytes);
            assert.ok(p.video && p.audio, 'picture and sound');
            assert.ok(Math.abs(p.duration - 9.5) < 0.8, `the copy is ${p.duration} s`);
        });

        await check('the pages: the original lists the cut with a link; the copy names its original; a copy is not cut again', async () => {
            const orig = await t.get(`/u/${A}`, { as: kim, headers: V });
            assert.ok(orig.text.includes('Pauses cut') && orig.text.includes(`href="/u/${copyId}"`) && orig.text.includes('1 pause out'));
            const copy = await t.get(`/u/${copyId}`, { as: kim, headers: V });
            assert.ok(copy.text.includes('An edited copy of') && copy.text.includes(`href="/u/${A}"`));
            await s.db.exec("UPDATE video_uploads SET status = 'ready', duration_seconds = 9.5 WHERE id = $1", [copyId]);
            const r = await t.get(`/api/v1/videos/${copyId}/cuts`, { as: kim, method: 'POST', json: { mode: 'pauses' }, headers: V });
            assert.deepStrictEqual([r.status, r.json().code], [409, 'cut.is_copy']);
        });

        await check('highlights: the reel comes from the AI edit and skips the pause search', async () => {
            await s.db.exec(`INSERT INTO video_upload_ai (upload_id, status, chapters, segments, highlights, updated_at) VALUES ($1, 'done', '[]', '[]', $2, $3)`,
                [A, JSON.stringify([{ start: 0.5, end: 3.5, score: 0.9 }, { start: 9.5, end: 13, score: 0.8 }]), s.iso()]);
            assert.ok(!(await t.get(`/u/${A}`, { as: kim, headers: V })).text.includes('Highlights reel'), 'a reel of 6.5 s is not offered (at least 20 s)');
            const wrong = await t.get(`/api/v1/videos/${A}/cuts`, { as: kim, method: 'POST', json: { mode: 'highlights' }, headers: V });
            assert.deepStrictEqual([wrong.status, wrong.json().code], [409, 'cut.no_highlights']);
            await s.db.exec('UPDATE video_upload_ai SET highlights = $2 WHERE upload_id = $1', [A, JSON.stringify([{ start: 0, end: 30, score: 0.9 }, { start: 40, end: 70, score: 0.8 }])]);
            await s.db.exec('UPDATE video_uploads SET duration_seconds = 120 WHERE id = $1', [A]);
            const page = await t.get(`/u/${A}`, { as: kim, headers: V });
            assert.ok(page.text.includes('Highlights reel') && page.text.includes('2 moments the AI picked, 1:00'), 'offered with its length');
            const ok = await t.get(`/api/v1/videos/${A}/cuts`, { as: kim, method: 'POST', json: { mode: 'highlights' }, headers: V });
            assert.strictEqual(ok.status, 202, ok.text);
            assert.deepStrictEqual(ok.json().cut.kept_seconds, 60);
            await s.db.exec("UPDATE video_cuts SET status = 'failed' WHERE id = $1", [ok.json().cut.id]);
            await s.db.exec('UPDATE video_uploads SET duration_seconds = 14 WHERE id = $1', [A]);
        });

        await check('no sound, no pauses: the cut fails with a plain reason', async () => {
            await t.get(`/u/${B}/cut`, { as: kim, form: { mode: 'pauses' }, headers: V });
            await t.ctx.videoCuts.sweep();
            const cut = (await t.get(`/api/v1/videos/${B}/cuts`, { as: kim, headers: V })).json().cuts[0];
            assert.deepStrictEqual([cut.status, cut.error], ['failed', 'This video has no sound to find pauses in.']);
            assert.strictEqual(Number(await s.db.value("SELECT count(*) FROM video_uploads WHERE edited_from = $1 AND state <> 'removed'", [B])), 0, 'no copy left behind');
        });

        await check('a cut a restart left mid-way loses its partial copy and goes back in the queue once', async () => {
            const partial = await t.ctx.videoUploads.startRecording({ requester: owner, username: 'kim' }, { title: 'partial', contentType: 'video/mp4' });
            await s.db.exec(`INSERT INTO video_cuts (id, upload_id, owner, mode, status, result_upload_id, attempts, created_at, updated_at)
                             VALUES ('vcut_01J0000000000000000000000Z', $1, $2, 'tight', 'rendering', $3, 1, $4, $4)`, [A, owner, partial.id, s.iso()]);
            await t.ctx.videoCuts.recover();
            const c = await t.ctx.videoCuts.byId('vcut_01J0000000000000000000000Z');
            assert.deepStrictEqual([c.status, c.result_upload_id], ['queued', null]);
            assert.strictEqual((await t.ctx.videoUploads.byId(partial.id)).state, 'removed');
        });
    } finally {
        await t0.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
    done();
})();
