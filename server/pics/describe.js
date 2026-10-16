'use strict';

/**
 * Alt text for OpenVibe.Pics: the uploader presses "Write alt text with AI" and OpenVibe.AI's pics.describe_image looks
 * at the picture's 640-pixel thumbnail (the first frame of an animation) and drafts alt text, a caption and tags. Only
 * on that press, never by itself: the picture goes to OpenVibe.AI, which may hand it to an outside model provider, and
 * the run keeps only the image's hash (cache_mode none). The draft becomes the picture's alt text (alt_source 'ai')
 * until the uploader edits it.
 *
 *   describe(row) → { ok: true, row } | { ok: false, status, code, detail }
 *
 * At most MEDIAHUB_PICS_AI_PER_DAY drafts a day for the whole site (300), on top of each person's pics.image.describe
 * budget. Off without OV_AI_INTERNAL_URL and the OAuth client secret, or with MEDIAHUB_PICS_AI=off.
 */
const { createServiceTokenClient } = require('openvibe-sdk/auth');
const store = require('./store');

const clean = (v, max) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

/** AI's output → the columns kept: alt (160), caption (400), up to six short lowercase tags. */
function draftOf(out) {
    if (!out || typeof out !== 'object') return null;
    const alt = clean(out.alt, 160).replace(/^(an? )?(image|picture|photo) of /i, '');
    if (!alt) return null;
    const tags = [...new Set((Array.isArray(out.tags) ? out.tags : []).map((t) => clean(t, 30).toLowerCase()).filter(Boolean))].slice(0, 6);
    return { alt: alt.charAt(0).toUpperCase() + alt.slice(1), caption: clean(out.caption, 400) || null, tags };
}

function createPicDescriber({ s, media, config, fetchImpl = globalThis.fetch, log = console }) {
    const url = String((config.ai && config.ai.internalUrl) || '').replace(/\/+$/, '');
    const enabled = Boolean(url && config.oauth.clientSecret && config.pics.ai !== false);
    const perDay = Math.max(0, Number(config.pics.aiPerDay) || 0);
    const tokens = enabled ? createServiceTokenClient({
        tokenUrl: `${config.networkInternalUrl}/oauth/token`, clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret,
        audience: 'openvibe.ai', fetch: fetchImpl,
    }) : null;
    const no = (status, code, detail) => ({ ok: false, status, code, detail });

    async function describe(row) {
        if (!enabled) return no(503, 'pics.ai_off', 'Alt text from AI is not available here.');
        if (row.state !== 'active') return no(409, 'pics.not_active', 'A hidden picture cannot be described.');
        const dayStart = `${new Date(s.now()).toISOString().slice(0, 10)}T00:00:00.000Z`;
        if (Number(await s.db.value('SELECT count(*) FROM pics_images WHERE ai_described_at >= $1', [dayStart])) >= perDay) {
            return no(429, 'pics.ai_daily_cap', 'OpenVibe.Pics has written all the alt text it can today. Try again tomorrow, or write it yourself.');
        }
        const got = await media.bytes(row.thumb_object_id || row.object_id);
        if (!got.ok) return no(502, 'pics.media_unavailable', 'The picture could not be read just now. Try again in a minute.');
        const bytes = Buffer.from(await got.res.arrayBuffer());
        const type = row.thumb_object_id ? 'image/webp' : row.mime_type;
        try {
            const token = await tokens.getToken();
            const res = await fetchImpl(`${url}/api/v1/runs?wait=45000`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    workflow: 'pics.describe_image',
                    input: { image: { data_url: `data:${type};base64,${bytes.toString('base64')}` }, ...(row.title ? { title: clean(row.title, 120) } : {}) },
                    target: { service: 'media-hub', type: 'picture', id: row.id },
                    idempotency_key: `media-hub.pics.describe:${row.id}:${s.now()}`,
                }),
                signal: AbortSignal.timeout(60_000),
            });
            const body = await res.json().catch(() => null);
            const run = body && body.run;
            if (res.status === 202 || (run && (run.status === 'queued' || run.status === 'running'))) {
                return no(503, 'pics.ai_slow', 'OpenVibe.AI is taking longer than usual. Try again in a minute.');
            }
            const draft = res.ok && run && run.status === 'succeeded' ? draftOf(run.output) : null;
            if (!draft) {
                log.warn(`[OpenVibe.Pics] describe ${row.id}: OpenVibe.AI answered ${res.status}${body && body.code ? ` (${body.code})` : ''}${run && run.error ? ` ${run.error.code || ''}` : ''}`);
                return no(502, 'pics.ai_failed', 'OpenVibe.AI could not describe this picture. Try again later, or write the alt text yourself.');
            }
            const saved = await store.updateImage(s, row.id, {
                alt: draft.alt, alt_source: 'ai', ai_caption: draft.caption, ai_tags: JSON.stringify(draft.tags), ai_described_at: s.iso(),
            });
            return { ok: true, row: saved };
        } catch (err) {
            log.warn(`[OpenVibe.Pics] describe ${row.id}:`, err.message);
            return no(502, 'pics.ai_failed', 'OpenVibe.AI could not be reached. Try again in a minute.');
        }
    }

    return { enabled, describe };
}

module.exports = { createPicDescriber, draftOf };
