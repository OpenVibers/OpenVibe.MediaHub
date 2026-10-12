'use strict';

/**
 * The pages of openvibe.video: public, read-only watch pages for OpenVibe.Live's stream recordings
 * (VODs) and clips. Everything here is server-rendered and complete without JavaScript; the one
 * script (public/js/video.js) only adds seeking and keeps the URL's `?t=` in step.
 *
 *   /                         what OpenVibe.Video is, then the latest recordings and clips
 *   /v/:id                    a VOD watch page (player, AI chapters and captions, its clips)
 *   /c/:id                    a clip watch page
 *   /@:username               a channel's recordings (and clips), newest first
 *   /v/:id/captions.vtt       the AI transcript as WebVTT captions
 *   /v/:id/chapters.vtt       the AI moments as WebVTT chapters
 *   /sitemap.xml /robots.txt /llms.txt   for the video host
 *
 * An unlisted item (visibility 'unlisted') is reachable by id but noindex and never in a list or
 * the sitemap. A private item is missing (Live already answers 404) and becomes a 404 here.
 */
const express = require('express');
const path = require('path');
const cache = require('openvibe-shared/cache-policy');
const seo = require('openvibe-shared/seo');
const ovServe = require('openvibe-shared/serve');
const { asyncRouter } = require('../http/router');
const { html } = require('../render/html');
const { send, assetVersion, SITE_NAME } = require('./layout');
const { createLiveClient } = require('./live-client');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const HOME_LIMIT = 10;
const SITEMAP_LIMIT = 30;
const CHANNEL_CLIPS_LIMIT = 12;
const PER_PAGE = 24;

// ── Small display helpers ───────────────────────────────────
/**
 * Only an https URL from Live reaches an href or src: the template escapes every value, but a
 * javascript: or data: URL would still be live. Anything else becomes null (no thumbnail, no link).
 */
function httpsUrl(u) {
    if (!u) return null;
    try { const x = new URL(String(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
}

function durationLabel(s) {
    const n = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const sec = n % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function dateLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** WebVTT timestamp: HH:MM:SS.mmm. */
function vttTime(s) {
    const totalMs = Math.max(0, Math.round((Number(s) || 0) * 1000));
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const sec = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** VTT cue text: drop a literal --> first, escape markup, then collapse newlines/whitespace. */
function cueText(s) {
    return String(s == null ? '' : s)
        .replace(/-->/g, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\s+/g, ' ')
        .trim();
}

function seg(s) {
    if (!s || typeof s !== 'object') return null;
    const start = Number(s.start);
    const end = Number(s.end);
    const text = String(s.text == null ? '' : s.text);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return { start, end, text };
}

/** Live stores ai_transcript_json as a JSON string; the public shape is an array. Take either. */
function transcriptSegments(vod) {
    const raw = vod && vod.ai_transcript_json;
    if (Array.isArray(raw)) return raw.map(seg).filter(Boolean);
    if (typeof raw === 'string') {
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.map(seg).filter(Boolean) : [];
        } catch { return []; }
    }
    return [];
}

function moments(list) {
    if (!Array.isArray(list)) return [];
    return list.map((m) => {
        if (!m || typeof m !== 'object') return null;
        const offset = Number(m.offset_seconds);
        return Number.isFinite(offset) ? { offset_seconds: offset, description: String(m.description == null ? '' : m.description) } : null;
    }).filter(Boolean).sort((a, b) => a.offset_seconds - b.offset_seconds);
}

const MAX_CHAPTERS = 12;
/** A moment's chapter title: what was seen (Live appends ' — heard: "…"', which the transcript already has). */
function chapterTitle(description) {
    const seen = String(description || '').split(/\s+[—–-]\s+heard:/)[0].trim().replace(/[.\s]+$/, '');
    if (seen.length <= 90) return seen;
    const cut = seen.slice(0, 90);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 50))}…`;
}

/** The AI moments as chapters: the first one, then one at least a twelfth of the stream later, at most twelve. */
function chapters(mems, durationSeconds) {
    const gap = Math.max(0, Number(durationSeconds) || 0) / MAX_CHAPTERS;
    const out = [];
    for (const m of mems) {
        if (out.length >= MAX_CHAPTERS) break;
        if (out.length && m.offset_seconds - out[out.length - 1].offset_seconds < gap) continue;
        out.push({ offset_seconds: m.offset_seconds, description: chapterTitle(m.description) });
    }
    return out;
}

function renderCaptionsVtt(segs) {
    const lines = ['WEBVTT', ''];
    for (const s of segs) {
        lines.push(`${vttTime(s.start)} --> ${vttTime(s.end)}`);
        lines.push(cueText(s.text));
        lines.push('');
    }
    return lines.join('\n');
}

function renderChaptersVtt(mems, durationSeconds) {
    const lines = ['WEBVTT', ''];
    for (let i = 0; i < mems.length; i++) {
        const start = mems[i].offset_seconds;
        const end = i + 1 < mems.length ? mems[i + 1].offset_seconds : Math.max(start, Number(durationSeconds) || 0);
        lines.push(`${vttTime(start)} --> ${vttTime(end)}`);
        lines.push(cueText(mems[i].description));
        lines.push('');
    }
    return lines.join('\n');
}

function meta(parts) {
    const present = parts.filter(Boolean);
    if (!present.length) return '';
    return html`<p class="ovv-card-meta">${present.map((p, i) => (i === 0 ? p : [html` · `, p]))}</p>`;
}

function card(o) {
    const channel = o.channel ? html`<a href="${o.channelHref}">@${o.channel}</a>` : null;
    return html`<article class="ovv-card">
<a class="ovv-card-media" href="${o.href}" tabindex="-1" aria-hidden="true">${o.thumb ? html`<img src="${o.thumb}" alt="" loading="lazy">` : html`<span class="ovv-card-placeholder"><i class="fa-solid ${o.kind === 'clip' ? 'fa-scissors' : 'fa-video'}"></i></span>`}${o.duration ? html`<span class="ovv-dur">${o.duration}</span>` : ''}${o.badge ? html`<span class="ovv-tag">${o.badge}</span>` : ''}</a>
<div class="ovv-card-body">
<h3 class="ovv-card-title"><a href="${o.href}">${o.title}</a></h3>
${meta([channel, o.date ? html`<time datetime="${o.iso}">${o.date}</time>` : null])}
</div>
</article>`;
}

function feedCard(item) {
    const href = item.kind === 'clip' ? `/c/${item.id}` : `/v/${item.id}`;
    return card({
        href,
        kind: item.kind,
        badge: item.ai ? 'AI clip' : null,
        thumb: httpsUrl(item.thumbnail_url),
        title: item.title || (item.kind === 'clip' ? 'Clip' : 'Stream recording'),
        channel: item.channel && item.channel.username ? item.channel.username : null,
        channelHref: item.channel && item.channel.username ? `/@${item.channel.username}` : null,
        duration: item.duration_seconds != null ? durationLabel(item.duration_seconds) : null,
        date: dateLabel(item.created_at) || null,
        iso: item.created_at || null,
    });
}

function vodCard(v) {
    return card({
        href: `/v/${v.id}`,
        thumb: httpsUrl(v.thumbnail_url),
        title: v.title || 'Stream recording',
        duration: v.duration_seconds != null ? durationLabel(v.duration_seconds) : null,
        date: dateLabel(v.created_at) || null,
        iso: v.created_at || null,
    });
}

function clipCard(c) {
    const dur = c.duration_seconds != null ? c.duration_seconds : c.duration;
    return card({
        href: `/c/${c.id}`,
        kind: 'clip',
        badge: c.auto_generated ? 'AI clip' : null,
        thumb: httpsUrl(c.thumbnail_url),
        title: c.title || 'Clip',
        duration: dur != null ? durationLabel(dur) : null,
        date: dateLabel(c.created_at) || null,
        iso: c.created_at || null,
    });
}

const grid = (cards, empty = 'Nothing here yet.') => (cards && cards.length ? html`<div class="ovv-grid">${cards}</div>` : html`<p class="muted">${empty}</p>`);

function createVideoRoutes(ctx) {
    const { config, log } = ctx;
    const live = createLiveClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
    const r = asyncRouter();
    const base = String(config.video.url).replace(/\/+$/, '');
    const livePublic = String(config.video.livePublicUrl).replace(/\/+$/, '');
    const videoHostname = (() => { try { return new URL(config.video.url).hostname; } catch { return 'openvibe.video'; } })();

    const page = (req, res, o, status = 200) => send(res, status, { ...o, baseUrl: base, path: req.originalUrl });
    const notFound = (req, res) => page(req, res, {
        title: 'Not found',
        cache: cache.htmlHeaders({ private: true }),
        body: html`<h1>Not found</h1><p class="muted">No page here. <a href="/">OpenVibe.Video</a>.</p>`,
    }, 404);
    const notFoundVtt = (_req, res) => res.status(404).set('Content-Type', 'text/plain; charset=utf-8').send('Not found');
    const sendVtt = (res, body) => res.set('Content-Type', 'text/vtt; charset=utf-8').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);

    // The shell's navbar/footer scripts come from the site's own /shared copy, and the one
    // product stylesheet/script live in public/.
    r.use('/shared', ovServe.handler());
    r.use(express.static(PUBLIC_DIR, {
        index: false, redirect: false,
        setHeaders(res, filePath) {
            const rel = path.relative(PUBLIC_DIR, filePath).split(path.sep).join('/');
            const v = res.req && res.req.query && res.req.query.v;
            res.setHeader('Cache-Control', cache.assetHeaders(rel, { hashed: !!v && v === assetVersion(rel) }));
        },
    }));

    // ── Home ────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const [vods, clips] = await Promise.all([
            live.feed({ type: 'vods', limit: HOME_LIMIT }),
            live.feed({ type: 'clips', limit: HOME_LIMIT }),
        ]);
        const vodItems = (vods && Array.isArray(vods.items)) ? vods.items : [];
        const clipItems = (clips && Array.isArray(clips.items)) ? clips.items : [];
        return page(req, res, {
            index: true,
            description: 'Stream recordings and clips from OpenVibe.Live, with AI chapters and captions.',
            body: html`<header class="ovv-hero"><p class="ovv-eyebrow"><i class="fa-solid fa-circle-play" aria-hidden="true"></i> OpenVibe.Video</p>
<h1>Watch what OpenVibe streamed.</h1>
<p class="ovv-lede">Stream recordings and clips from OpenVibe.Live, with AI chapters and captions. Uploads are not open here — watch what people made public on OpenVibe.Live.</p>
<p class="ovv-hero-actions"><a class="ovv-btn ovv-btn--primary" href="${livePublic}/">Live now on OpenVibe.Live</a> <a class="ovv-btn" href="${livePublic}/docs/go-live-in-your-browser">Go live from your browser</a></p></header>
<section class="ovv-section" aria-labelledby="h-vods"><h2 id="h-vods">Latest recordings</h2>${grid(vodItems.map(feedCard), 'No recordings yet.')}</section>
<section class="ovv-section" aria-labelledby="h-clips"><h2 id="h-clips">Latest clips</h2>${grid(clipItems.map(feedCard), 'No clips yet.')}</section>`,
        });
    });

    // ── WebVTT tracks ───────────────────────────────────────
    r.get('/v/:id/captions.vtt', async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFoundVtt(req, res);
        const data = await live.vod(id);
        if (!data || !data.vod) return notFoundVtt(req, res);
        const segs = transcriptSegments(data.vod);
        if (!segs.length) return notFoundVtt(req, res);
        return sendVtt(res, renderCaptionsVtt(segs));
    });

    r.get('/v/:id/chapters.vtt', async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFoundVtt(req, res);
        const data = await live.vod(id);
        if (!data || !data.vod) return notFoundVtt(req, res);
        let mems = [];
        try {
            const m = await live.vodMemories(id);
            mems = chapters(moments(m && m.memories), data.vod.duration_seconds);
        } catch { mems = []; }
        if (!mems.length) return notFoundVtt(req, res);
        return sendVtt(res, renderChaptersVtt(mems, data.vod.duration_seconds));
    });

    // ── VOD watch page ──────────────────────────────────────
    r.get('/v/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);

        const data = await live.vod(id);
        if (!data || !data.vod) return notFound(req, res);
        const vod = data.vod;
        const clips = Array.isArray(data.clips) ? data.clips.filter((c) => c && c.visibility !== 'private') : [];

        const segs = transcriptSegments(vod);
        let mems = [];
        try {
            const m = await live.vodMemories(id);
            mems = chapters(moments(m && m.memories), vod.duration_seconds);
        } catch { mems = []; }
        let threadUrl = null;
        try {
            const cm = await live.comments('vod', id);
            threadUrl = httpsUrl(cm && cm.thread && cm.thread.url);
        } catch { threadUrl = null; }

        const unlisted = vod.visibility === 'unlisted';
        const channelName = vod.display_name || vod.username || null;
        const localChannel = vod.username ? `/@${vod.username}` : null;
        const liveChannel = `${livePublic}/@${vod.username}`;
        const manage = `${livePublic}/vod/${id}`;
        const metaParts = [];
        if (vod.created_at) metaParts.push(html`<time datetime="${vod.created_at}">${dateLabel(vod.created_at)}</time>`);
        if (vod.duration_seconds != null) metaParts.push(durationLabel(vod.duration_seconds));
        if (vod.stream_category) metaParts.push(vod.stream_category);
        if (vod.view_count != null) metaParts.push(`${Number(vod.view_count) || 0} views`);

        return page(req, res, {
            index: !unlisted,
            noindex: unlisted,
            title: vod.title || 'Stream recording',
            description: vod.description || vod.ai_overview || '',
            scripts: ['js/video.js'],
            body: html`<div class="ovv-watch">
<div class="ovv-main">
<div class="ovv-player-wrap"><video class="ovv-player" controls preload="metadata" playsinline src="${httpsUrl(vod.playback_url) || ''}" data-ovv-video>${segs.length ? html`<track kind="captions" label="Transcript (AI)" src="/v/${id}/captions.vtt" default>` : ''}${mems.length ? html`<track kind="chapters" src="/v/${id}/chapters.vtt">` : ''}</video></div>
<h1 class="ovv-title">${vod.title || 'Stream recording'}</h1>
<div class="ovv-byline">
${channelName ? html`<a class="ovv-avatar" href="${localChannel || liveChannel}" aria-hidden="true" tabindex="-1">${String(channelName).slice(0, 1).toUpperCase()}</a>` : ''}
<div class="ovv-byline-text">${channelName ? (localChannel ? html`<a class="ovv-channel-name" href="${localChannel}">@${channelName}</a>` : html`<span class="ovv-channel-name">@${channelName}</span>`) : ''}
${metaParts.length ? html`<span class="ovv-meta">${metaParts.map((p, i) => (i === 0 ? p : [html` · `, p]))}</span>` : ''}</div>
<div class="ovv-byline-actions">${channelName ? html`<a class="ovv-btn" href="${liveChannel}"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Channel on OpenVibe.Live</a>` : ''}${threadUrl ? html`<a class="ovv-btn" href="${threadUrl}"><i class="fa-regular fa-comments" aria-hidden="true"></i> Discuss on OpenVibe.Community</a>` : ''}</div>
</div>
${vod.is_recording ? html`<p class="ovv-recording" role="status"><i class="fa-solid fa-circle" aria-hidden="true"></i> This recording is still in progress. <a href="${liveChannel}">Watch the live channel</a>.</p>` : ''}
${vod.ai_overview ? html`<section class="ovv-panel" aria-labelledby="h-overview"><h2 id="h-overview">About this stream</h2><p>${vod.ai_overview}</p><p class="ovv-fine">Written by AI from the stream.</p></section>` : ''}
${segs.length ? html`<details class="ovv-panel ovv-transcript"><summary>Transcript <span class="ovv-fine">(AI, ${segs.length} lines)</span></summary><div class="ovv-transcript-body">${segs.map((s) => html`<p><button type="button" class="ovv-seek" data-ovv-seek="${s.start}">${vttTime(s.start).slice(0, 8)}</button> <span>${s.text}</span></p>`)}</div></details>` : ''}
</div>
<aside class="ovv-side">
${mems.length ? html`<section class="ovv-panel ovv-chapters" aria-labelledby="h-chapters"><h2 id="h-chapters">Chapters</h2><ol>${mems.map((m) => html`<li><a href="/v/${id}?t=${m.offset_seconds}" data-ovv-chapter="${m.offset_seconds}"><span class="ovv-time">${vttTime(m.offset_seconds).slice(0, 8)}</span><span>${m.description}</span></a></li>`)}</ol><p class="ovv-fine">From the AI moments of the stream.</p></section>` : ''}
${clips.length ? html`<section class="ovv-panel" aria-labelledby="h-clips"><h2 id="h-clips">Clips from this stream</h2><div class="ovv-grid ovv-grid--side">${clips.map(clipCard)}</div></section>` : ''}
<p class="ovv-manage"><a href="${manage}">Manage on OpenVibe.Live</a> <span class="ovv-fine">· owner tools (visibility, clips, delete) stay on Live for now</span></p>
</aside>
</div>`,
        });
    });

    // ── Clip watch page ─────────────────────────────────────
    r.get('/c/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);

        const data = await live.clip(id);
        if (!data || !data.clip) return notFound(req, res);
        const clip = data.clip;

        let threadUrl = null;
        try {
            const cm = await live.comments('clip', id);
            threadUrl = httpsUrl(cm && cm.thread && cm.thread.url);
        } catch { threadUrl = null; }

        const unlisted = clip.visibility === 'unlisted';
        const fullRecording = clip.vod_id ? `/v/${clip.vod_id}${clip.start_time != null ? `?t=${clip.start_time}` : ''}` : null;
        const sourceName = clip.source_streamer_display_name || clip.source_streamer_username || 'the streamer';
        const madeBy = clip.display_name || clip.username || 'an OpenVibe member';
        const attribution = clip.auto_generated ? `AI clip from ${sourceName}'s stream` : `Made by ${madeBy}`;

        return page(req, res, {
            index: !unlisted,
            noindex: unlisted,
            title: clip.title || 'Clip',
            description: clip.ai_overview || '',
            scripts: ['js/video.js'],
            body: html`<div class="ovv-watch ovv-watch--clip">
<div class="ovv-main">
<div class="ovv-player-wrap"><video class="ovv-player" controls preload="metadata" playsinline src="${httpsUrl(clip.playback_url) || ''}" data-ovv-video></video></div>
<h1 class="ovv-title">${clip.title || 'Clip'}</h1>
<div class="ovv-byline">
<div class="ovv-byline-text"><span class="ovv-channel-name">${clip.auto_generated ? html`<span class="ovv-tag ovv-tag--inline">AI clip</span> ` : ''}${attribution}</span>
${clip.created_at ? html`<span class="ovv-meta"><time datetime="${clip.created_at}">${dateLabel(clip.created_at)}</time>${clip.duration_seconds != null ? html` · ${durationLabel(clip.duration_seconds)}` : ''}</span>` : ''}</div>
<div class="ovv-byline-actions">${fullRecording ? html`<a class="ovv-btn ovv-btn--primary" href="${fullRecording}"><i class="fa-solid fa-film" aria-hidden="true"></i> Watch in the full recording</a>` : ''}${threadUrl ? html`<a class="ovv-btn" href="${threadUrl}"><i class="fa-regular fa-comments" aria-hidden="true"></i> Discuss on OpenVibe.Community</a>` : ''}</div>
</div>
${clip.ai_overview ? html`<section class="ovv-panel"><p>${clip.ai_overview}</p><p class="ovv-fine">Written by AI from the clip.</p></section>` : ''}
<p class="ovv-manage"><a href="${livePublic}/clip/${id}">Manage on OpenVibe.Live</a></p>
</div>
</div>`,
        });
    });

    // ── Channel page ────────────────────────────────────────
    r.get('/@:username', async (req, res) => {
        const username = String(req.params.username || '');
        if (!live.isUsername(username)) return notFound(req, res);

        const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
        const offset = (pageNum - 1) * PER_PAGE;

        const out = await live.vodsByUser(username, { limit: PER_PAGE, offset });
        const vods = Array.isArray(out && out.vods)
            ? out.vods.filter((v) => v && v.visibility !== 'private' && v.visibility !== 'unlisted')
            : [];
        vods.sort((a, b) => (Date.parse(String(b.created_at || '')) || 0) - (Date.parse(String(a.created_at || '')) || 0));
        const hasMore = !!(out && out.hasMore);

        let clips = [];
        try {
            const c = await live.clipsByUser(username, { limit: CHANNEL_CLIPS_LIMIT });
            clips = Array.isArray(c && c.clips)
                ? c.clips.filter((x) => x && x.visibility !== 'private' && x.visibility !== 'unlisted')
                : [];
        } catch { clips = []; }

        const prevLink = pageNum > 1 ? `?page=${pageNum - 1}` : null;
        const nextLink = hasMore ? `?page=${pageNum + 1}` : null;

        return page(req, res, {
            index: true,
            title: `@${username}`,
            description: `Recordings and clips from @${username} on OpenVibe.Video.`,
            body: html`<header class="ovv-channel-head"><span class="ovv-avatar ovv-avatar--big" aria-hidden="true">${username.slice(0, 1).toUpperCase()}</span><div><h1>@${username}</h1><p class="ovv-meta">Recordings and clips from this channel's streams on OpenVibe.Live.</p></div><a class="ovv-btn" href="${livePublic}/@${username}"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Channel on OpenVibe.Live</a></header>
<section class="ovv-section" aria-labelledby="h-vods"><h2 id="h-vods">Recordings</h2>${grid(vods.map(vodCard), 'No recordings yet.')}${prevLink || nextLink ? html`<nav class="ovv-pagination" aria-label="Pages">${prevLink ? html`<a href="${prevLink}">← Newer</a>` : ''}${nextLink ? html`<a href="${nextLink}">Older →</a>` : ''}</nav>` : ''}</section>
${clips.length ? html`<section class="ovv-section" aria-labelledby="h-clips"><h2 id="h-clips">Clips</h2>${grid(clips.map(clipCard), 'No clips yet.')}</section>` : ''}`,
        });
    });

    // ── Discovery: robots.txt, sitemap.xml, llms.txt ────────
    r.get('/sitemap.xml', async (req, res) => {
        const [vods, clips] = await Promise.all([
            live.feed({ type: 'vods', limit: SITEMAP_LIMIT }),
            live.feed({ type: 'clips', limit: SITEMAP_LIMIT }),
        ]);
        const items = [...((vods && vods.items) || []), ...((clips && clips.items) || [])];
        const urls = items.map((it) => ({ loc: `${base}${it.kind === 'clip' ? '/c/' : '/v/'}${it.id}` }));
        return res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.sitemapXml(urls));
    });

    r.get('/robots.txt', (_req, res) => {
        return res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
            .send(`# openvibe.video: the public watch pages are for search and AI crawlers.\n${seo.robotsTxt({ sitemaps: [`${base}/sitemap.xml`] })}`);
    });

    r.get('/llms.txt', async (req, res) => {
        const [vods, clips] = await Promise.all([
            live.feed({ type: 'vods', limit: SITEMAP_LIMIT }),
            live.feed({ type: 'clips', limit: SITEMAP_LIMIT }),
        ]);
        const vodItems = (vods && vods.items) || [];
        const clipItems = (clips && clips.items) || [];
        const links = (items, kind) => items.map((it) => ({ title: it.title || (kind === 'vod' ? 'Recording' : 'Clip'), url: `${base}/${kind === 'vod' ? 'v' : 'c'}/${it.id}` }));
        return res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'Public watch pages for stream recordings and clips from OpenVibe.Live.',
            details: 'AI chapters and captions are rendered on the watch pages. Uploads are not open.',
            sections: [
                { title: 'Start here', links: [{ title: SITE_NAME, url: `${base}/` }] },
                { title: 'Latest recordings', links: links(vodItems, 'vod') },
                { title: 'Latest clips', links: links(clipItems, 'clip') },
            ],
        }));
    });

    // ── Legal pages name this host (openvibe.video), not the drive's host ──
    const legal = require('openvibe-shared/legal');
    r.get(legal.PATHS, legal.handler({ id: 'media-hub', service: 'media-hub', host: videoHostname, name: 'OpenVibe.Video', profile: 'ugc' }));

    // ── Video host 404 and errors ───────────────────────────
    r.use((req, res) => notFound(req, res));

    // eslint-disable-next-line no-unused-vars
    r.use((err, req, res, _next) => {
        log.error('[OpenVibe.Video]', err && err.message ? err.message.slice(0, 300) : err);
        if (res.headersSent) return undefined;
        if (err && err.liveUnavailable) {
            return page(req, res, {
                title: 'OpenVibe.Live did not answer',
                cache: cache.htmlHeaders({ private: true }),
                body: html`<h1>OpenVibe.Live did not answer</h1><p class="muted">Try again in a minute. The recordings and clips are still on OpenVibe.Live.</p>`,
            }, 502);
        }
        return page(req, res, {
            title: 'Something went wrong',
            cache: cache.htmlHeaders({ private: true }),
            body: html`<h1>Something went wrong on our side</h1><p class="muted">Try again in a moment.</p>`,
        }, 500);
    });

    return r;
}

module.exports = { createVideoRoutes, chapters, chapterTitle };
