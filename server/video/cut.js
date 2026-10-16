'use strict';

/**
 * The AI cut of an OpenVibe.Video upload: an edited copy, made here, of a finished upload of the person's own.
 *
 *   pauses       every pause of 1.5 seconds or more becomes half a second (lead-in and tail silence go)
 *   tight        every pause of 0.7 seconds or more becomes 0.3 seconds
 *   highlights   a reel of the best moments the AI edit found (server/video/ai-edit.js), in time order, at most 3 minutes
 *
 * The copy is a new private upload of the same person (video_uploads.edited_from), made through the same path as a
 * browser recording (uploads.startRecording → chunk → complete), so Media gives it a probe, thumbnail and HLS, the AI
 * edit gives it captions and chapters, and it counts toward the person's daily uploads and storage. The original is
 * never changed.
 *
 * One cut at a time on this host: ffmpeg reads the original through Media's signed URL on MEDIAHUB_MEDIA_URL (never a
 * public address), finds the pauses (silencedetect, sound only), then re-encodes the kept ranges (trim and concat, H.264
 * veryfast and AAC, at most 1080 lines) as fragmented MP4 on its stdout, which goes to Media in 8 MB pieces while it is
 * made: no file on this disk. ffmpeg runs under `nice 19` with two threads, so live streams on the box keep the CPU.
 * A copy is re-encoded rather than cut on keyframes because a browser recording (WebM) may have one keyframe in minutes.
 *
 *   plan…(…)          the pure parts: pauses → kept ranges, highlights → reel
 *   request(row, who, mode)   queue a cut (one waiting or running per person, VIDEO_CUTS_PER_DAY a day)
 *   forUpload(row)    the cuts of an upload, newest first
 *   sweep()           the worker: one queued cut at a time; a cut left mid-way by a restart is retried once
 */
const { spawn } = require('child_process');
const { UploadError } = require('./uploads');

const MODES = Object.freeze({
    pauses: { label: 'pauses cut', minPause: 1.5, keep: 0.25 },
    tight: { label: 'tight cut', minPause: 0.7, keep: 0.15 },
    highlights: { label: 'highlights', reelMax: 180, picks: 6 },
});
const PIECE = 8 * 1024 * 1024;
const MAX_RANGES = 400;
const r2 = (n) => Math.round(n * 100) / 100;

/** ffmpeg's silencedetect lines → [{ start, end }] (a silence still open at the end runs to `duration`). */
function parseSilence(text, duration) {
    const out = [];
    let open = null;
    for (const line of String(text).split('\n')) {
        let m;
        if ((m = /silence_start:\s*(-?[\d.]+)/.exec(line))) open = Math.max(0, Number(m[1]));
        else if ((m = /silence_end:\s*([\d.]+)/.exec(line)) && open != null) { out.push({ start: open, end: Number(m[1]) }); open = null; }
    }
    if (open != null && duration > open) out.push({ start: open, end: duration });
    return out;
}

/**
 * Pauses → the ranges kept. Each pause of at least `minPause` keeps `keep` seconds at either side (so a cut never
 * clips a word); one at the very start or end goes entirely but for `keep`. Null when nothing worth cutting.
 */
function planPauses(silences, duration, mode = 'pauses') {
    const m = MODES[mode];
    if (!m || !m.minPause || !(duration > 0)) return null;
    let removed = [];
    for (const sp of (silences || []).slice().sort((a, b) => a.start - b.start)) {
        const a = Math.max(0, Number(sp.start));
        const b = Math.min(duration, Number(sp.end));
        if (!(b - a >= m.minPause)) continue;
        const from = a <= 0.05 ? 0 : a + m.keep;
        const to = b >= duration - 0.05 ? duration : b - m.keep;
        if (to - from > 0.1) removed.push([from, to]);
    }
    // Too many pieces for one filter graph: keep the longest cuts.
    if (removed.length > MAX_RANGES - 1) {
        removed = removed.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).slice(0, MAX_RANGES - 1).sort((x, y) => x[0] - y[0]);
    }
    const ranges = [];
    let at = 0;
    for (const [from, to] of removed) {
        if (from > at + 0.05) ranges.push([r2(at), r2(from)]);
        at = Math.max(at, to);
    }
    if (duration > at + 0.05) ranges.push([r2(at), r2(duration)]);
    const kept = ranges.reduce((n, [a, b]) => n + (b - a), 0);
    if (!ranges.length || duration - kept < 0.5) return null;
    return { ranges, kept_seconds: r2(kept), removed_count: removed.length };
}

/**
 * The AI edit's highlights → a reel: the best `picks`, in time order, overlaps merged, at most `reelMax` seconds.
 * Older AI edits kept only chapter starts: each becomes a 30-second window.
 */
function planHighlights(ai, duration) {
    const m = MODES.highlights;
    if (!ai || ai.status !== 'done' || !(duration > 0)) return null;
    let list = Array.isArray(ai.highlights) && ai.highlights.length ? ai.highlights
        : (ai.chapters || []).filter((c) => c.start > 0 || c.title !== 'Start').map((c) => ({ start: c.start, end: c.start + 30, score: 0 }));
    list = list.map((h) => ({ start: Math.max(0, Number(h.start)), end: Math.min(duration, Number(h.end)), score: Number(h.score) || 0 }))
        .filter((h) => h.end - h.start >= 3)
        .sort((a, b) => b.score - a.score).slice(0, m.picks)
        .sort((a, b) => a.start - b.start);
    const ranges = [];
    let total = 0;
    for (const h of list) {
        const last = ranges[ranges.length - 1];
        if (last && h.start <= last[1]) { total += Math.max(0, h.end - last[1]); last[1] = Math.max(last[1], h.end); }
        else { ranges.push([h.start, h.end]); total += h.end - h.start; }
        if (total >= m.reelMax) break;
    }
    const out = ranges.map(([a, b]) => [r2(a), r2(b)]);
    const kept = out.reduce((n, [a, b]) => n + (b - a), 0);
    if (out.length < 2 || kept < 20 || kept > duration - 10) return null;
    return { ranges: out, kept_seconds: r2(kept), removed_count: null };
}

/** The filter graph for the kept ranges (trim/atrim each, concat, scale to at most 1080 lines, even sizes). */
function filterGraph(ranges, { audio = true } = {}) {
    const parts = [];
    const pads = [];
    ranges.forEach(([a, b], i) => {
        parts.push(`[0:v:0]trim=start=${a}:end=${b},setpts=PTS-STARTPTS[v${i}]`);
        if (audio) parts.push(`[0:a:0]atrim=start=${a}:end=${b},asetpts=PTS-STARTPTS[a${i}]`);
        pads.push(audio ? `[v${i}][a${i}]` : `[v${i}]`);
    });
    parts.push(`${pads.join('')}concat=n=${ranges.length}:v=1:a=${audio ? 1 : 0}[vc]${audio ? '[ac]' : ''}`);
    parts.push("[vc]scale=-2:'trunc(min(ih,1080)/2)*2',format=yuv420p[vo]");
    return parts.join(';\n');
}

function createCuts({ s, media, uploads, videoAi = null, config, log = console, spawnImpl = spawn }) {
    const cfg = config.videoCuts;
    const enabled = Boolean(cfg && cfg.enabled);
    const mediaBase = String((config.media && config.media.url) || '').replace(/\/+$/, '');
    const byId = (id) => s.db.maybe('SELECT * FROM video_cuts WHERE id = $1', [id]);
    const save = async (id, patch) => {
        const cols = Object.keys(patch);
        await s.db.query(`UPDATE video_cuts SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = $2 WHERE id = $1`,
            [id, s.iso(), ...cols.map((c) => (c === 'ranges' && patch[c] != null ? JSON.stringify(patch[c]) : patch[c]))]);
    };

    /** ffmpeg (or ffprobe) under nice, its stdout handed to `onStdout` when given; → { code, stderr }. */
    function run(bin, args, { onStdout = null, onStderr = null, timeoutMs = cfg.timeoutMs } = {}) {
        return new Promise((resolve) => {
            const child = spawnImpl('nice', ['-n', String(cfg.nice), bin, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            let done = false;
            const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stderr: stderr.slice(-20000) }); } };
            const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } finish(-1); }, timeoutMs);
            if (timer.unref) timer.unref();
            child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200000) stderr = stderr.slice(-100000); if (onStderr) onStderr(String(d)); });
            if (onStdout) onStdout(child.stdout, child);
            else child.stdout.resume();
            child.on('error', () => finish(-2));
            child.on('close', (code) => finish(code));
        });
    }

    async function probe(url) {
        let out = '';
        const r = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', url], {
            onStdout: (stdout) => stdout.on('data', (d) => { out += d; }), timeoutMs: 60_000,
        });
        if (r.code !== 0) return null;
        try {
            const j = JSON.parse(out);
            const streams = j.streams || [];
            return {
                duration: Number(j.format && j.format.duration) || 0,
                video: streams.some((x) => x.codec_type === 'video'),
                audio: streams.some((x) => x.codec_type === 'audio'),
            };
        } catch { return null; }
    }

    /** The original's bytes, read from Media's own address (the signature covers the id and expiry, not the host). */
    async function sourceUrl(row) {
        const signed = await media.vodSignedUrl(row.media_vod_id, 6 * 3600);
        if (!signed.ok || !signed.data || !signed.data.url) throw new Error(`Media gave no readable address (${signed.code || signed.status})`);
        const u = new URL(signed.data.url);
        return mediaBase ? `${mediaBase}${u.pathname}${u.search}` : signed.data.url;
    }

    async function request(row, who, mode) {
        if (!enabled) throw new UploadError(503, 'cut.off', 'The AI cut is not available here.');
        if (!MODES[mode]) throw new UploadError(422, 'cut.mode', 'Choose pauses, tight or highlights.');
        if (!who || who.requester !== row.owner) throw new UploadError(403, 'cut.not_yours', 'Only the person who uploaded a video can cut it.');
        if (row.status !== 'ready' || row.state !== 'active') throw new UploadError(409, 'cut.not_ready', 'The video has to be ready (and not hidden) first.');
        if (row.edited_from) throw new UploadError(409, 'cut.is_copy', 'This is already an edited copy: cut the original instead.');
        if (Number(row.duration_seconds) > cfg.maxSourceSeconds) throw new UploadError(413, 'cut.too_long', `The AI cut takes videos up to ${Math.round(cfg.maxSourceSeconds / 3600)} hours.`);
        let plan = null;
        if (mode === 'highlights') {
            plan = planHighlights(videoAi ? await videoAi.forUpload(row) : null, Number(row.duration_seconds));
            if (!plan) throw new UploadError(409, 'cut.no_highlights', 'The AI edit found no highlights to make a reel from.');
        }
        const pending = await s.db.value("SELECT count(*) FROM video_cuts WHERE owner = $1 AND status IN ('queued', 'measuring', 'rendering')", [row.owner]);
        if (Number(pending) > 0) throw new UploadError(409, 'cut.busy', 'One of your cuts is still being made. Start the next when it is done.');
        const today = Number(await s.db.value('SELECT count(*) FROM video_cuts WHERE owner = $1 AND created_at >= $2', [row.owner, s.iso().slice(0, 10)]));
        if (today >= cfg.perDay) throw new UploadError(429, 'cut.daily_limit', `That is ${cfg.perDay} cuts today. Try again tomorrow.`);
        const id = s.newId('vcut');
        const now = s.iso();
        await s.db.query(`INSERT INTO video_cuts (id, upload_id, owner, mode, ranges, source_seconds, kept_seconds, created_at, updated_at)
                          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [id, row.id, row.owner, mode, plan ? JSON.stringify(plan.ranges) : null, Number(row.duration_seconds) || null, plan ? plan.kept_seconds : null, now]);
        kick();
        return await byId(id);
    }

    async function measure(cut, url, duration) {
        const m = MODES[cut.mode];
        const r = await run(cfg.ffmpeg, ['-hide_banner', '-nostdin', '-i', url, '-map', '0:a:0', '-vn', '-af', `silencedetect=n=${cfg.silenceDb}dB:d=${m.minPause}`, '-f', 'null', '-']);
        if (r.code !== 0) throw new Error('ffmpeg could not read the sound');
        return planPauses(parseSilence(r.stderr, duration), duration, cut.mode);
    }

    /** Render the kept ranges into the copy, piece by piece, while ffmpeg makes them. */
    async function render(cut, url, ranges, kept, info, copy) {
        let n = 0;
        let held = [];
        let heldBytes = 0;
        let failure = null;
        let lastSaved = 0;
        const send = async (buf) => {
            n += 1;
            copy = await uploads.chunk(copy, n, buf);
        };
        const graph = filterGraph(ranges, { audio: info.audio });
        const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:2', '-nostats', '-i', url,
            '-filter_complex', graph, '-map', '[vo]', ...(info.audio ? ['-map', '[ac]', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an']),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', String(cfg.threads),
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
        let consumer = Promise.resolve();
        const r = await run(cfg.ffmpeg, args, {
            onStdout: (stdout, child) => {
                // Reading pauses while a piece goes to Media, so ffmpeg waits on the pipe instead of filling memory.
                consumer = (async () => {
                    try {
                        for await (const d of stdout) {
                            held.push(d);
                            heldBytes += d.length;
                            if (heldBytes >= PIECE) {
                                const buf = Buffer.concat(held);
                                held = [buf.subarray(PIECE)];
                                heldBytes = held[0].length;
                                await send(buf.subarray(0, PIECE));
                            }
                        }
                        if (heldBytes) await send(Buffer.concat(held));
                    } catch (err) {
                        failure = err;
                        try { child.kill('SIGKILL'); } catch { /* gone */ }
                        stdout.resume();
                    }
                })();
            },
            onStderr: (text) => {
                const m = /out_time_us=(\d+)/.exec(text);
                if (!m || !kept) return;
                const p = Math.min(0.99, Number(m[1]) / 1e6 / kept);
                if (Date.now() - lastSaved > 5000) { lastSaved = Date.now(); save(cut.id, { progress: p }).catch(() => {}); }
            },
        });
        await consumer;
        if (failure) throw failure;
        if (r.code !== 0) throw new Error(`ffmpeg stopped (${r.code}): ${(r.stderr.split('\n').filter((l) => l && !/^[a-z_]+=/.test(l)).pop() || '').slice(0, 200)}`);
        return copy;
    }

    async function work(cut) {
        const original = await uploads.byId(cut.upload_id);
        if (!original || original.state !== 'active' || original.status !== 'ready') return save(cut.id, { status: 'failed', error: 'The original is no longer available.', finished_at: s.iso() });
        let copy = null;
        try {
            await save(cut.id, { status: 'measuring', attempts: cut.attempts + 1, started_at: s.iso(), progress: 0, error: null });
            const url = await sourceUrl(original);
            const info = await probe(url);
            if (!info || !info.video) throw new UploadError(422, 'cut.no_video', 'There is no picture in this video to cut.');
            const duration = info.duration || Number(original.duration_seconds) || 0;
            let plan = cut.ranges ? { ranges: typeof cut.ranges === 'string' ? JSON.parse(cut.ranges) : cut.ranges, kept_seconds: Number(cut.kept_seconds), removed_count: null } : null;
            if (!plan) {
                if (!info.audio) throw new UploadError(422, 'cut.no_sound', 'This video has no sound to find pauses in.');
                plan = await measure(cut, url, duration);
                if (!plan) throw new UploadError(422, 'cut.nothing', 'No pauses long enough to cut were found.');
            }
            await save(cut.id, { status: 'rendering', ranges: plan.ranges, kept_seconds: plan.kept_seconds, removed_count: plan.removed_count, source_seconds: duration });
            const label = MODES[cut.mode].label;
            copy = await uploads.startRecording({ requester: original.owner, username: original.owner_username }, {
                title: `${original.title.slice(0, 100)} (${label})`, description: original.description, visibility: 'private', contentType: 'video/mp4',
            });
            await s.db.query('UPDATE video_uploads SET edited_from = $2 WHERE id = $1', [copy.id, original.id]);
            await save(cut.id, { result_upload_id: copy.id });
            copy = await render(cut, url, plan.ranges, plan.kept_seconds, info, copy);
            await uploads.complete(copy);
            return save(cut.id, { status: 'done', progress: 1, finished_at: s.iso() });
        } catch (err) {
            const known = err instanceof UploadError;
            if (!known) log.warn(`[OpenVibe.Video] cut ${cut.id}:`, err.message);
            if (copy) await uploads.remove(copy).catch(() => {});
            return save(cut.id, { status: 'failed', error: known ? err.detail : 'The cut could not be made. Try again later.', finished_at: s.iso() });
        }
    }

    let busy = false;
    async function sweep() {
        if (!enabled || busy) return 0;
        busy = true;
        try {
            const next = await s.db.maybe("SELECT * FROM video_cuts WHERE status = 'queued' ORDER BY created_at LIMIT 1");
            if (!next) return 0;
            await work(next);
            return 1;
        } finally { busy = false; }
    }

    /** At boot: a cut a restart left half-made loses its partial copy and goes back in the queue once. */
    async function recover() {
        if (!enabled) return;
        for (const c of await s.db.many("SELECT * FROM video_cuts WHERE status IN ('measuring', 'rendering')")) {
            if (c.result_upload_id) {
                const copy = await uploads.byId(c.result_upload_id);
                if (copy && copy.status === 'uploading') await uploads.remove(copy).catch(() => {});
            }
            const again = c.attempts < 2;
            await save(c.id, again ? { status: 'queued', result_upload_id: null, progress: 0 } : { status: 'failed', error: 'The cut was interrupted. Try again.', finished_at: s.iso() });
        }
    }

    let kicked = null;
    function kick() {
        if (!enabled || kicked) return;
        kicked = setTimeout(() => { kicked = null; sweep().catch((err) => log.warn('[OpenVibe.Video] cut sweep:', err.message)); }, 1000);
        if (kicked.unref) kicked.unref();
    }

    return {
        enabled, MODES, request, sweep, recover, kick, byId,
        forUpload: async (row) => (await s.db.many('SELECT * FROM video_cuts WHERE upload_id = $1 ORDER BY created_at DESC LIMIT 10', [row.id]))
            .map((c) => ({ ...c, ranges: typeof c.ranges === 'string' ? JSON.parse(c.ranges) : c.ranges })),
        highlightsPlan: async (row) => planHighlights(videoAi ? await videoAi.forUpload(row) : null, Number(row.duration_seconds)),
    };
}

module.exports = { createCuts, planPauses, planHighlights, parseSilence, filterGraph, MODES };
