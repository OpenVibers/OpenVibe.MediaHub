'use strict';

/**
 * The AI edit of an OpenVibe.Video upload: OpenVibe.AI's media.analyze on the finished video (local speech-to-text with
 * whisper.cpp, scene and loudness signals, highlights and an overview from a local model; never a paid model here,
 * allow_paid false). Its results become:
 *   captions   the transcript as WebVTT (/u/:id/captions.vtt), a track on the player
 *   chapters   the highlights in time order, each named by what was said (/u/:id/chapters.vtt and a list)
 *   overview   a short description, labelled as written by AI, which the owner may take as the video's description
 *
 * Media gives AI a signed URL to read (private videos too); AI keeps nothing of the video but the run. One run per
 * attempt, keyed (media-hub.video.analyze:<id>:<attempt>): a run still going after a minute is joined again by its key
 * on the next sweep, never started twice. A failure waits and retries (up to 4 attempts).
 *
 *   sweep()          every few minutes: queue ready uploads that have no AI row, then work the due rows (2 at a time)
 *   forUpload(row)   the AI row of an upload, parsed (or null)
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');

const MAX_ATTEMPTS = 4;
const parse = (v, d) => { if (v == null) return d; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return d; } };
const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** Highlights → chapters: in time order, at least 20 s apart, each named by the words said there. */
function chaptersOf(highlights) {
    const list = (Array.isArray(highlights) ? highlights : [])
        .filter((h) => h && Number.isFinite(Number(h.start)))
        .map((h) => ({ start: Math.max(0, Math.round(Number(h.start))), title: clean(h.excerpt, 70) || 'Highlight' }))
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const c of list) if (!out.length || c.start - out[out.length - 1].start >= 20) out.push(c);
    if (out.length && out[0].start > 0) out.unshift({ start: 0, title: 'Start' });
    return out.slice(0, 30);
}

function createAiEdit({ s, media, config, fetchImpl = globalThis.fetch, log = console }) {
    const url = String(config.ai.internalUrl || '').replace(/\/+$/, '');
    const enabled = Boolean(url && config.oauth.clientSecret && config.ai.videoAnalysis);
    const tokens = enabled ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', fetch: fetchImpl,
    }) : null;

    async function run(input, idempotencyKey, target) {
        const token = await tokens.getToken();
        const res = await fetchImpl(`${url}/api/v1/runs?wait=60000`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ workflow: 'media.analyze', input, target, idempotency_key: idempotencyKey }),
            signal: AbortSignal.timeout(75_000),
        });
        const body = await res.json().catch(() => null);
        if (!res.ok && res.status !== 202) throw new Error(`OpenVibe.AI answered ${res.status}${body && body.code ? ` (${body.code})` : ''}`);
        return body && body.run;
    }

    const later = (minutes) => new Date(s.now() + minutes * 60_000).toISOString();
    const save = (id, patch) => {
        const cols = Object.keys(patch);
        return s.db.query(`UPDATE video_upload_ai SET ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_at = $2 WHERE upload_id = $1`, [id, s.iso(), ...cols.map((c) => patch[c])]);
    };

    async function work(ai) {
        const upload = await s.db.maybe('SELECT * FROM video_uploads WHERE id = $1', [ai.upload_id]);
        if (!upload || upload.state === 'removed' || upload.status !== 'ready') return save(ai.upload_id, { status: 'failed', error: 'The video is gone.', next_at: null });
        // A run still going is joined by the same key; a new attempt gets a new key.
        const attempt = ai.status === 'running' ? ai.attempts : ai.attempts + 1;
        if (ai.status !== 'running') await save(ai.upload_id, { status: 'running', attempts: attempt, next_at: later(15) });
        try {
            const signed = await media.vodSignedUrl(upload.media_vod_id, 6 * 3600);
            if (!signed.ok || !signed.data || !signed.data.url) throw new Error(`Media gave no readable URL (${signed.code || signed.status})`);
            const r = await run({ media_url: signed.data.url, language: 'auto', allow_paid: false }, `media-hub.video.analyze:${upload.id}:${attempt}`, { service: 'media-hub', type: 'video', id: upload.id });
            if (r && (r.status === 'queued' || r.status === 'running')) return save(ai.upload_id, { run_id: r.id || null, next_at: later(10) });
            const out = r && r.status === 'succeeded' && r.output;
            if (!out || !out.transcript || !Array.isArray(out.transcript.segments)) throw new Error((r && r.error && (r.error.code || r.error.detail)) || (r && r.status) || 'no result');
            const segments = out.transcript.segments.filter((x) => x && Number.isFinite(Number(x.start)) && Number.isFinite(Number(x.end)) && clean(x.text, 500))
                .map((x) => ({ start: Number(x.start), end: Number(x.end), text: clean(x.text, 500) })).slice(0, 5000);
            return save(ai.upload_id, {
                status: 'done', run_id: r.id || null, error: null, next_at: null,
                overview: out.overview && out.overview.text ? clean(out.overview.text, 1500) : null,
                chapters: JSON.stringify(chaptersOf(out.highlights)), segments: JSON.stringify(segments),
                language: out.transcript.language ? clean(out.transcript.language, 8) : null,
            });
        } catch (err) {
            const done = attempt >= MAX_ATTEMPTS;
            log.warn(`[OpenVibe.Video] AI edit of ${ai.upload_id} (attempt ${attempt}):`, err.message);
            return save(ai.upload_id, { status: done ? 'failed' : 'queued', error: clean(err.message, 300), next_at: done ? null : later(2 ** attempt * 5) });
        }
    }

    let sweeping = false;
    async function sweep() {
        if (!enabled || sweeping) return 0;
        sweeping = true;
        try {
            await s.db.query(`INSERT INTO video_upload_ai (upload_id, status, updated_at)
                              SELECT u.id, 'queued', $1 FROM video_uploads u LEFT JOIN video_upload_ai a ON a.upload_id = u.id
                               WHERE u.status = 'ready' AND u.state <> 'removed' AND a.upload_id IS NULL
                              ON CONFLICT DO NOTHING`, [s.iso()]);
            const due = await s.db.many(`SELECT * FROM video_upload_ai WHERE status IN ('queued', 'running') AND (next_at IS NULL OR next_at <= $1)
                                          ORDER BY updated_at LIMIT 2`, [s.iso()]);
            for (const ai of due) await work(ai);
            return due.length;
        } finally { sweeping = false; }
    }

    return {
        enabled, sweep,
        async forUpload(row) {
            const ai = await s.db.maybe('SELECT * FROM video_upload_ai WHERE upload_id = $1', [row.id]);
            return ai ? { ...ai, chapters: parse(ai.chapters, []), segments: parse(ai.segments, []) } : null;
        },
    };
}

module.exports = { createAiEdit, chaptersOf };
