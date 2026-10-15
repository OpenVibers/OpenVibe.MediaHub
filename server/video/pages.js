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
const { sameOrigin } = require('../http/principal');
const { html, raw, notice } = require('../render/html');
const frame = require('openvibe-shared/frame');
const { send, asset, assetVersion, SITE_NAME } = require('./layout');
const { createLiveClient, LiveRefusedError } = require('./live-client');
const { createChatClient } = require('./chat-client');
const { createVideoApiRoutes } = require('./api');
const { createUploadApi, mountUploadPages } = require('./upload-routes');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../auth/sso');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const HOME_LIMIT = 10;
const SITEMAP_LIMIT = 30;     // Live's feed page size (its MAX_LIMIT)
const SITEMAP_PAGES = 5;      // per kind: up to 150 recordings and 150 clips
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

/**
 * A card's thumbnail: openvibe.media's thumbnails come in sizes (Media's /t/:id?w=&fmt=, Fabric F4), so a card asks for
 * a WebP near the width it shows (about 13 KB for 480 px instead of the 24 KB 640 px JPEG). Any other image is used
 * as it is. `sizes` is the card's rendered width in the grid (one column on a phone, five across a desktop).
 */
const THUMB_WIDTHS = [320, 480, 640];
function thumbImg(url, sizes) {
    if (!/^https:\/\/openvibe\.media\/t\/[^?#\s]+$/.test(url || '')) return html`<img src="${url}" alt="" loading="lazy">`;
    const srcset = THUMB_WIDTHS.map((w) => `${url}?w=${w}&fmt=webp ${w}w`).join(', ');
    return html`<img src="${`${url}?w=480&fmt=webp`}" srcset="${srcset}" sizes="${sizes}" alt="" loading="lazy">`;
}
const CARD_SIZES = '(max-width: 520px) calc(100vw - 32px), (max-width: 820px) 45vw, 240px';

/**
 * An item's playable file. Live's `file_url` is always the file; its `playback_url` is the HLS playlist when Media has
 * one (Live T4 step 5), so it is only the fallback for answers from before `file_url` existed.
 */
function fileOf(item) {
    return httpsUrl(item.file_url) || httpsUrl(item.playback_url);
}

/** The player's HLS source: Media's timeline playlist, for a finished item that has one, on the playback file's origin. */
function hlsAttrs(item) {
    const hls = !item.is_recording && httpsUrl(item.hls_url);
    const file = fileOf(item);
    if (!hls || !file || new URL(hls).origin !== new URL(file).origin) return '';
    return html` data-ovv-hls="${hls}" data-ovv-hls-lib="${asset('vendor/hls.light.min.js')}"`;
}

function durationLabel(s) {
    const n = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const sec = n % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Seconds → an ISO 8601 duration (PT1H2M3S), or undefined. */
function isoDuration(seconds) {
    const n = Math.floor(Number(seconds));
    if (!Number.isFinite(n) || n <= 0) return undefined;
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}

/** "1:02:03", "2:03", "123" or "123.5" → seconds, or NaN. */
function parseClock(v) {
    const t = String(v == null ? '' : v).trim();
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d(?:\.\d+)?)$/.exec(t);
    if (!m) return NaN;
    return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]);
}
/** Seconds → "m:ss" or "h:mm:ss". */
function clock(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = String(n % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
const CLIP_MAX_SECONDS = 60;   // Live's default max_clip_duration; Live has the last word and says so

const isoTime = (v) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString() : undefined; };

/**
 * schema.org VideoObject for a public watch page (Google's video results): the page, the thumbnail, the upload time,
 * the duration, the file, the view count, the channel and, for a recording, its chapters as Clip parts (key moments).
 */
function videoLd({ base, path, item, title, description, chapterList, partOf }) {
    const pageUrl = `${base}${path}`;
    const thumb = httpsUrl(item.thumbnail_url);
    const channel = item.display_name || item.username;
    const parts = (chapterList || []).map((m, i, all) => ({
        '@type': 'Clip',
        name: String(m.description || `Chapter ${i + 1}`).slice(0, 110),
        startOffset: m.offset_seconds,
        ...(all[i + 1] ? { endOffset: all[i + 1].offset_seconds } : (Number(item.duration_seconds) > m.offset_seconds ? { endOffset: Math.floor(Number(item.duration_seconds)) } : {})),
        url: `${pageUrl}?t=${m.offset_seconds}`,
    }));
    return {
        ...seo.jsonLd.video({
            name: title, url: pageUrl, description: String(description || title).slice(0, 500),
            thumbnailUrl: thumb ? [thumb] : undefined, uploadDate: isoTime(item.created_at),
            duration: isoDuration(item.duration_seconds), contentUrl: fileOf(item) || undefined, embedUrl: pageUrl,
        }),
        ...(item.view_count != null ? { interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(item.view_count) || 0 } } : {}),
        ...(channel ? { author: { '@type': 'Person', name: channel, ...(item.username ? { url: `${base}/@${item.username}` } : {}) } } : {}),
        publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' },
        ...(parts.length ? { hasPart: parts } : {}),
        ...(partOf ? { isPartOf: { '@type': 'VideoObject', url: `${base}${partOf}` } } : {}),
    };
}

function dateLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
/** A UTC timestamp: chat uses 'YYYY-MM-DD HH:MM:SS'; Live's stream times may be ISO. Returns seconds or NaN. */
function utcSeconds(v) {
    if (v == null) return NaN;
    const s = String(v).trim();
    if (!s) return NaN;
    const iso = /[TtZz]/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t / 1000 : NaN;
}

/** An offset into the stream as H:MM:SS (no leading zero on the hour). */
function streamTime(s) {
    const n = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const sec = n % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** A short "2 hours ago" for a comment's created time. */
function relativeDate(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`;
    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`;
    const y = Math.floor(mo / 12);
    return `${y} year${y === 1 ? '' : 's'} ago`;
}

/** The replay messages that belong in the chat panel: oldest first, at most 1,000, null when none. */
function chatMessageRows(vod, messages) {
    const start = utcSeconds(vod && vod.stream_started_at);
    if (!Number.isFinite(start) || !Array.isArray(messages)) return null;
    const end = utcSeconds(vod.stream_ended_at);
    const rows = [];
    for (const m of messages) {
        if (!m || typeof m !== 'object') continue;
        if (m.is_deleted || m.is_filtered) continue;
        if (m.message_type !== 'chat') continue;
        const at = utcSeconds(m.timestamp);
        if (!Number.isFinite(at)) continue;
        const offset = at - start;
        if (offset < 0) continue;
        if (Number.isFinite(end) && offset > end - start + 60) continue;
        rows.push({ offset: Math.floor(offset), name: m.display_name || m.username || '', text: m.message == null ? '' : String(m.message) });
    }
    rows.sort((a, b) => a.offset - b.offset);
    if (!rows.length) return null;
    const leftOut = rows.length > 1000 ? rows.length - 1000 : 0;
    return { rows: rows.slice(0, 1000), leftOut };
}

function commentItem(c) {
    const name = c.display_name || c.username || '';
    const text = c.message == null ? '' : String(c.message);
    const replies = Number(c.reply_count) || 0;
    return html`<article class="ovv-comment">
<header class="ovv-comment-header"><span class="ovv-comment-author">${name}</span>${c.created_at ? html`<time class="ovv-comment-date" datetime="${c.created_at}">${relativeDate(c.created_at)}</time>` : ''}</header>
<p class="ovv-comment-text">${text}</p>
${replies > 0 ? html`<p class="ovv-comment-replies"><i class="fa-regular fa-comments" aria-hidden="true"></i> ${replies} ${replies === 1 ? 'reply' : 'replies'}</p>` : ''}
</article>`;
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
<a class="ovv-card-media" href="${o.href}" tabindex="-1" aria-hidden="true">${o.thumb ? thumbImg(o.thumb, CARD_SIZES) : html`<span class="ovv-card-placeholder"><i class="fa-solid ${o.kind === 'clip' ? 'fa-scissors' : 'fa-video'}"></i></span>`}${o.duration ? html`<span class="ovv-dur">${o.duration}</span>` : ''}${o.badge ? html`<span class="ovv-tag">${o.badge}</span>` : ''}</a>
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
    const { config, log, playlists } = ctx;

    // A channel page lists that person's public playlists, which are stored by subject: the username is resolved
    // through Network (identity.subject.resolve) and remembered for ten minutes (an unknown name for one), at most
    // 1,000, so a crawled channel page is not a Network call per visit.
    const subjects = new Map();   // username (lowercase) → { at, ttl, subject }
    async function subjectOf(username) {
        const key = username.toLowerCase();
        const hit = subjects.get(key);
        if (hit && Date.now() - hit.at < hit.ttl) return hit.subject;
        const subject = ctx.identity && ctx.identity.resolveUsername ? await ctx.identity.resolveUsername(username) : null;
        subjects.delete(key);
        subjects.set(key, { at: Date.now(), ttl: subject ? 600_000 : 60_000, subject });
        if (subjects.size > 1000) subjects.delete(subjects.keys().next().value);
        return subject;
    }
    const live = createLiveClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
    const chat = createChatClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
    const r = asyncRouter();
    const base = String(config.video.url).replace(/\/+$/, '');
    const livePublic = String(config.video.livePublicUrl).replace(/\/+$/, '');
    const videoHostname = (() => { try { return new URL(config.video.url).hostname; } catch { return 'openvibe.video'; } })();

    const hasSessionCookie = (req) => Boolean(req.cookies && (req.cookies[ACCESS_COOKIE] || req.cookies[REFRESH_COOKIE]));
    const page = (req, res, o, status = 200) => send(res, status, {
        ...o,
        viewer: req.viewer,
        private: o.private !== false && hasSessionCookie(req),
        baseUrl: base,
        path: req.originalUrl,
    });
    const notFound = (req, res) => page(req, res, {
        title: 'Not found',
        cache: cache.htmlHeaders({ private: true }),
        body: html`<h1>Not found</h1><p class="muted">No page here. <a href="/">OpenVibe.Video</a>.</p>`,
    }, 404);
    const notFoundVtt = (_req, res) => res.status(404).set('Content-Type', 'text/plain; charset=utf-8').send('Not found');
    const sendVtt = (res, body) => res.set('Content-Type', 'text/vtt; charset=utf-8').set('Cache-Control', cache.htmlHeaders({ maxAge: 300 })).send(body);

    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const ownerOf = (req) => `user:${req.viewer.subject}`;
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;
    const mustSignIn = (back, why) => (req, res, next) => (signedIn(req) ? next() : page(req, res, {
        title: 'Sign in',
        body: html`<h1>Sign in first</h1>${signInPrompt(why, back === 'here' ? req.originalUrl : back)}`,
    }, 401));
    function sameSite(req, res, back) {
        if (sameOrigin(req, config.video.url)) return true;
        page(req, res, {
            title: 'Not from this site',
            body: html`<h1>That came from somewhere else</h1><p class="muted">A signed-in page that changes something has to come from openvibe.video itself. <a href="${back}">Go back</a> and try again.</p>`,
        }, 403);
        return false;
    }
    const visibilityLabel = (v) => (v === 'public' ? 'Public' : (v === 'unlisted' ? 'Unlisted' : 'Private'));

    // ── Owner tools ─────────────────────────────────────────
    // A recording's channel and a clip's maker or channel see a Manage panel. The panel only decides what to show:
    // every change is made on OpenVibe.Live AS the signed-in person (their Network token as a Bearer, through
    // sso.asViewer so an expired session is refreshed once), and Live decides whether they may make it.
    const VISIBILITIES = ['public', 'unlisted', 'private'];
    const sameName = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
    const isStaff = (req) => ['admin', 'global_mod'].includes(String((req.viewer && req.viewer.role) || ''));
    function mayManage(req, kind, item) {
        if (!signedIn(req) || !item) return false;
        if (isStaff(req)) return true;
        const me = req.viewer.username;
        if (kind === 'vod') return sameName(me, item.username);
        return sameName(me, item.username) || sameName(me, item.source_streamer_username) || sameName(me, item.channel_username);
    }
    const asPerson = (req, res, fn) => ctx.sso.asViewer(req, res, fn);
    /** A signed-in person's own view of an item Live hides from everyone else (private), or null. */
    async function ownView(req, res, kind, id) {
        if (!signedIn(req)) return null;
        try {
            const data = await asPerson(req, res, (token) => (kind === 'vod' ? live.vodAs(token, id) : live.clipAs(token, id)));
            const item = data && (kind === 'vod' ? data.vod : data.clip);
            return item && mayManage(req, kind, item) ? data : null;
        } catch (err) {
            if (err instanceof LiveRefusedError) return null;
            throw err;
        }
    }
    function ownerRefused(req, res, err, back) {
        const refused = err instanceof LiveRefusedError;
        if (!refused && !(err && err.liveUnavailable)) throw err;
        const status = refused ? (err.status === 401 ? 401 : err.status === 404 ? 404 : 403) : 502;
        return page(req, res, {
            title: 'Not saved',
            cache: cache.htmlHeaders({ private: true }),
            body: html`<h1>That was not saved</h1>${notice(refused ? `OpenVibe.Live said: ${err.message}` : err.message, 'bad')}<p><a class="ovv-btn" href="${back}">Go back</a></p>`,
        }, status);
    }
    const savedNotice = (req) => (req.query.saved === '1' ? notice('Saved on OpenVibe.Live.', 'ok') : '');
    const visibilityOptions = (current) => VISIBILITIES.map((v) => html`<option value="${v}"${v === current ? ' selected' : ''}>${visibilityLabel(v)}</option>`);
    /** "Make a clip" of a finished recording, for any signed-in viewer who can see it (Live's rule, as on Live). */
    function clipPanel(req, id, vod) {
        if (vod.is_recording) return '';
        if (!signedIn(req)) {
            return html`<section class="ovv-panel ovv-clipper" aria-labelledby="h-clip"><h2 id="h-clip">Make a clip</h2><p class="ovv-fine"><a href="/auth/login?next=${encodeURIComponent(req.originalUrl)}">Sign in with OpenVibe</a> to cut a clip of up to ${CLIP_MAX_SECONDS} seconds from this recording.</p></section>`;
        }
        const dur = Math.floor(Number(vod.duration_seconds) || 0);
        return html`<details class="ovv-panel ovv-clipper" data-ovv-clipper><summary><h2 id="h-clip">Make a clip</h2></summary>
<form class="ovv-owner-form" method="post" action="/v/${id}/clip">
<div class="ovv-clip-times">
<label class="ovv-field"><span>Start</span><input name="start" type="text" inputmode="numeric" placeholder="0:00" pattern="[0-9:.]{1,12}" required data-ovv-clip-start></label>
<label class="ovv-field"><span>End</span><input name="end" type="text" inputmode="numeric" placeholder="0:30" pattern="[0-9:.]{1,12}" required data-ovv-clip-end></label>
</div>
<p class="ovv-clip-now" hidden data-ovv-clip-now><button type="button" class="ovv-btn" data-ovv-clip-mark="start">Start here</button> <button type="button" class="ovv-btn" data-ovv-clip-mark="end">End here</button></p>
<label class="ovv-field"><span>Title <span class="ovv-fine">(optional)</span></span><input name="title" type="text" maxlength="100"></label>
<p class="ovv-fine">Up to ${CLIP_MAX_SECONDS} seconds${dur ? `, within ${clock(dur)}` : ''}. Times are m:ss or h:mm:ss. The clip is cut on OpenVibe.Media and credited to you.</p>
<button class="ovv-btn ovv-btn--primary" type="submit">Make the clip</button>
</form></details>`;
    }

    function ownerPanel(kind, id, item) {
        const what = kind === 'vod' ? 'recording' : 'clip';
        const action = `/${kind === 'vod' ? 'v' : 'c'}/${id}`;
        return html`<section class="ovv-panel ovv-owner" aria-labelledby="h-owner"><h2 id="h-owner">Manage this ${what}</h2>
<form class="ovv-owner-form" method="post" action="${action}/manage">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="200" value="${item.title || ''}" required></label>
${kind === 'vod' ? html`<label class="ovv-field"><span>Description</span><textarea name="description" rows="3" maxlength="2000">${item.description || ''}</textarea></label>` : ''}
<label class="ovv-field"><span>Visibility</span><select name="visibility">${visibilityOptions(item.visibility || 'public')}</select></label>
<p class="ovv-fine">Public is listed and searchable; unlisted opens only by its link; private only for you and staff.</p>
<button class="ovv-btn ovv-btn--primary" type="submit">Save changes</button>
</form>
<details class="ovv-danger"><summary>Delete this ${what}</summary>
<form class="ovv-owner-delete" method="post" action="${action}/delete"><label class="ovv-confirm"><input type="checkbox" name="confirm" value="1" required> I want to delete it for good</label> <button class="ovv-btn ovv-btn--danger" type="submit">Delete</button></form>
</details>
</section>`;
    }

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

    // ── Playlist API (openvibe.video only; the drive's /api/v1 is untouched) ──
    r.use('/api/v1/video', createVideoApiRoutes(ctx));
    // Uploads' part API (server/video/upload-routes.js): raw parts and its own JSON, before the forms' parser.
    r.use('/api/v1/videos', createUploadApi({ ctx, config }));
    // The playlist forms are web forms (no JavaScript): urlencoded text. The API router above has its own JSON
    // parser, so the two never read each other's bodies.
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));

    // ── Uploads: /upload, /u/:id, /me/videos (server/video/upload-routes.js) ──
    const uploadCard = mountUploadPages(r, { ctx, page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, visibilityOptions, visibilityLabel, durationLabel, dateLabel, httpsUrl, fileOf, hlsAttrs, grid, card, renderCaptionsVtt, renderChaptersVtt, vttTime, sendVtt, notFoundVtt });

    // ── Playlist page pieces ───────────────────────────────
    async function playlistForm(req, kind, id) {
        if (!signedIn(req)) {
            return html`<a class="ovv-btn" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}"><i class="fa-solid fa-plus" aria-hidden="true"></i> Sign in to save to a playlist</a>`;
        }
        const lists = await playlists.list(ownerOf(req));
        return html`<details class="ovv-save"><summary class="ovv-btn"><i class="fa-solid fa-plus" aria-hidden="true"></i> Save to playlist</summary>
<form class="ovv-save-form" method="post" action="/playlists/add">
<input type="hidden" name="kind" value="${kind}">
<input type="hidden" name="id" value="${id}">
<span class="ovv-save-label">Add to playlist</span>
<select name="playlist" aria-label="Choose a playlist or make a new one"><option value="">New playlist…</option>${lists.map((p) => html`<option value="${p.id}">${p.title}</option>`)}</select>
<input name="title" type="text" maxlength="${playlists.TITLE_MAX}" placeholder="New playlist title" aria-label="New playlist title">
<button class="ovv-btn ovv-btn--primary" type="submit">Save</button>
</form></details>`;
    }

    async function upNext(req, kind, id) {
        const listId = String(req.query.list || '');
        if (!playlists.isPlaylistId(listId)) return { html: '', nextUrl: null };
        const pl = await playlists.get(listId);
        if (!pl) return { html: '', nextUrl: null };
        const items = await playlists.items(pl.id);
        const idx = items.findIndex((x) => x.kind === kind && Number(x.item_id) === Number(id));
        const next = idx >= 0 ? items[idx + 1] : items[0];
        if (!next) return { html: '', nextUrl: null };
        const nextId = Number(next.item_id);
        const nextUrl = `${next.kind === 'vod' ? '/v/' : '/c/'}${nextId}?list=${encodeURIComponent(pl.id)}`;
        let label = `${next.kind === 'vod' ? 'VOD' : 'Clip'} ${nextId}`;
        try {
            const data = next.kind === 'vod' ? await live.vod(nextId) : await live.clip(nextId);
            const info = data && (next.kind === 'vod' ? data.vod : data.clip);
            if (info && info.title) label = info.title;
        } catch { /* Live unavailable: keep the id label */ }
        return {
            html: html`<section class="ovv-panel ovv-upnext" aria-label="Up next"><p class="ovv-upnext-in">Up next in <a href="/playlists/${pl.id}">${pl.title}</a></p><a class="ovv-upnext-link" href="${nextUrl}"><i class="fa-solid fa-play" aria-hidden="true"></i> <span>${label}</span></a><p class="ovv-fine">Plays on its own when this one ends.</p></section>`,
            nextUrl,
        };
    }

    const itemControls = (plId, it) => html`<div class="ovv-item-controls">
<form class="ovv-inline" method="post" action="/playlists/${plId}/items/${it.kind}/${Number(it.item_id)}/up"><button class="ovv-btn" type="submit" aria-label="Move up">↑</button></form>
<form class="ovv-inline" method="post" action="/playlists/${plId}/items/${it.kind}/${Number(it.item_id)}/down"><button class="ovv-btn" type="submit" aria-label="Move down">↓</button></form>
<form class="ovv-inline" method="post" action="/playlists/${plId}/items/${it.kind}/${Number(it.item_id)}/remove"><button class="ovv-btn" type="submit">Remove</button></form>
</div>`;

    function playlistRow(p) {
        const n = Number(p.item_count) || 0;
        return html`<li class="ovv-playlist-row">
<div class="ovv-playlist-main"><a class="ovv-playlist-title" href="/playlists/${p.id}">${p.title}</a>
<span class="ovv-meta">${visibilityLabel(p.visibility)} · ${n} item${n === 1 ? '' : 's'} · updated ${dateLabel(p.updated_at)}</span></div>
<details class="ovv-pl-edit"><summary class="ovv-btn"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit</summary>
<div class="ovv-playlist-actions">
<form class="ovv-inline" method="post" action="/playlists/${p.id}/rename"><input name="title" type="text" maxlength="${playlists.TITLE_MAX}" value="${p.title}" aria-label="New title" required> <button class="ovv-btn" type="submit">Rename</button></form>
<form class="ovv-inline" method="post" action="/playlists/${p.id}/visibility"><select name="visibility" aria-label="Visibility">${playlists.VISIBILITIES.map((v) => html`<option value="${v}"${v === p.visibility ? ' selected' : ''}>${visibilityLabel(v)}</option>`)}</select> <button class="ovv-btn" type="submit">Change</button></form>
<form class="ovv-inline" method="post" action="/playlists/${p.id}/delete"><label class="ovv-confirm"><input type="checkbox" name="confirm" value="1" required> I want to delete it</label> <button class="ovv-btn ovv-btn--danger" type="submit">Delete</button></form>
</div></details>
</li>`;
    }

    /** A public playlist on a channel page: its title and size, no owner controls. */
    function publicPlaylistRow(p) {
        const n = Number(p.item_count) || 0;
        return html`<li class="ovv-playlist-row"><div class="ovv-playlist-main"><a class="ovv-playlist-title" href="/playlists/${p.id}">${p.title}</a>
<span class="ovv-meta">${n} item${n === 1 ? '' : 's'} · updated ${dateLabel(p.updated_at)}</span></div></li>`;
    }

    function playlistError(req, res, out) {
        const code = out && out.code;
        const status = code === 'playlist.not_found' || code === 'playlist.item_not_found' ? 404 : (code === 'playlist.item_duplicate' ? 409 : 422);
        return page(req, res, {
            title: 'Playlist',
            body: html`<h1>That did not go through</h1>${notice((out && out.detail) || 'Something went wrong.', 'warn')}<p><a class="ovv-btn" href="/playlists">Back to your playlists</a></p>`,
        }, status);
    }

    async function handleMove(req, res, dir) {
        if (!sameSite(req, res, `/playlists/${req.params.id}`)) return undefined;
        const owner = ownerOf(req);
        const pl = await playlists.own(owner, String(req.params.id || ''));
        if (!pl) return playlistError(req, res, { code: 'playlist.not_found', detail: 'No such playlist.' });
        const kind = String(req.params.kind || '');
        const itemId = req.params.itemId;
        const items = await playlists.items(pl.id);
        const idx = items.findIndex((x) => x.kind === kind && Number(x.item_id) === Number(itemId));
        if (idx < 0) return playlistError(req, res, { code: 'playlist.item_not_found', detail: 'No such item.' });
        const other = dir === 'up' ? idx - 1 : idx + 1;
        if (other < 0 || other >= items.length) return res.redirect(303, `/playlists/${pl.id}`);
        const list = items.map((x) => ({ kind: x.kind, id: Number(x.item_id) }));
        const tmp = list[idx]; list[idx] = list[other]; list[other] = tmp;
        const out = await playlists.reorder(owner, pl.id, list);
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, `/playlists/${pl.id}`);
    }

    // ── Home ────────────────────────────────────────────────
    r.get('/', async (req, res) => {
        const [vods, clips] = await Promise.all([
            live.feed({ type: 'vods', limit: HOME_LIMIT }),
            live.feed({ type: 'clips', limit: HOME_LIMIT }),
        ]);
        const vodItems = (vods && Array.isArray(vods.items)) ? vods.items : [];
        const clipItems = (clips && Array.isArray(clips.items)) ? clips.items : [];
        const uploaded = await ctx.videoUploads.latest(HOME_LIMIT);
        return page(req, res, {
            index: true,
            description: 'Videos people upload, and stream recordings and clips from OpenVibe.Live with AI chapters and captions.',
            body: html`<header class="ovv-hero"><p class="ovv-eyebrow"><i class="fa-solid fa-circle-play" aria-hidden="true"></i> OpenVibe.Video</p>
<h1>Watch, upload, stream.</h1>
<p class="ovv-lede">Videos people upload here, and the recordings and clips of streams on OpenVibe.Live with AI chapters and captions. Sign in with your OpenVibe account to upload: it plays everywhere, on your channel at openvibe.video/@you.</p>
<p class="ovv-hero-actions"><a class="ovv-btn ovv-btn--primary" href="/upload"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload a video</a> <a class="ovv-btn" href="${livePublic}/">Live now on OpenVibe.Live</a> <a class="ovv-btn" href="${livePublic}/docs/go-live-in-your-browser">Go live from your browser</a></p></header>
${uploaded.length ? html`<section class="ovv-section" aria-labelledby="h-uploads"><h2 id="h-uploads">Latest uploads</h2>${grid(uploaded.map(uploadCard))}</section>` : ''}
<section class="ovv-section" aria-labelledby="h-vods"><h2 id="h-vods">Latest recordings</h2>${grid(vodItems.map(feedCard), 'No recordings yet.')}</section>
<section class="ovv-section" aria-labelledby="h-clips"><h2 id="h-clips">Latest clips</h2>${grid(clipItems.map(feedCard), 'No clips yet.')}</section>`,
        });
    });

    // ── What shipped: the shared update log, as on every OpenVibe site (MediaHub's log: Video and Download ship together) ──
    r.get('/updates', (req, res) => page(req, res, {
        index: true,
        title: 'What shipped on OpenVibe.Video',
        description: 'Every change deployed to OpenVibe.Video, newest first.',
        body: raw(frame.updatesBody({ service: 'media-hub', siteName: 'OpenVibe.Video' }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

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

        let data = await live.vod(id);
        let ownOnly = false;
        if (!data || !data.vod) {
            data = await ownView(req, res, 'vod', id);
            ownOnly = true;
        }
        if (!data || !data.vod) return notFound(req, res);
        const vod = data.vod;
        const manageable = mayManage(req, 'vod', vod);
        const clips = Array.isArray(data.clips) ? data.clips.filter((c) => c && c.visibility !== 'private') : [];

        const segs = transcriptSegments(vod);
        let mems = [];
        try {
            const m = await live.vodMemories(id);
            mems = chapters(moments(m && m.memories), vod.duration_seconds);
        } catch { mems = []; }
        let threadUrl = null;
        let commentRows = [];
        let commentsOk = false;
        try {
            const cm = await live.comments('vod', id);
            threadUrl = httpsUrl(cm && cm.thread && cm.thread.url);
            const list = Array.isArray(cm && cm.comments) ? cm.comments : [];
            commentRows = list.filter((c) => c && !c.is_deleted && !c.deleted).slice(0, 20);
            commentsOk = true;
        } catch { threadUrl = null; }

        let chatRows = null;
        try {
            const replay = await chat.chatReplay(vod.stream_id);
            chatRows = chatMessageRows(vod, replay && Array.isArray(replay.messages) ? replay.messages : []);
        } catch { chatRows = null; }

        const unlisted = vod.visibility === 'unlisted';
        const channelName = vod.display_name || vod.username || null;
        const localChannel = vod.username ? `/@${vod.username}` : null;
        const liveChannel = `${livePublic}/@${vod.username}`;
        const metaParts = [];
        if (vod.created_at) metaParts.push(html`<time datetime="${vod.created_at}">${dateLabel(vod.created_at)}</time>`);
        if (vod.duration_seconds != null) metaParts.push(durationLabel(vod.duration_seconds));
        if (vod.stream_category) metaParts.push(vod.stream_category);
        if (vod.view_count != null) metaParts.push(`${Number(vod.view_count) || 0} views`);

        const saveForm = await playlistForm(req, 'vod', id);
        const up = await upNext(req, 'vod', id);
        const nextAttr = up.nextUrl ? html` data-ovv-next="${up.nextUrl}"` : '';
        const viewAttr = html` data-ovv-view="${livePublic}/api/views/vod/${id}"`;
        const hlsAttr = hlsAttrs(vod);

        return page(req, res, {
            index: !unlisted && !ownOnly,
            noindex: unlisted || ownOnly,
            ...(ownOnly ? { cache: cache.htmlHeaders({ private: true }) } : {}),
            title: vod.title || 'Stream recording',
            description: vod.description || vod.ai_overview || '',
            ...(ownOnly || vod.is_recording ? {} : {
                jsonLd: videoLd({ base, path: `/v/${id}`, item: vod, title: vod.title || 'Stream recording', description: vod.description || vod.ai_overview, chapterList: mems }),
                image: httpsUrl(vod.thumbnail_url) || undefined, ogType: 'video.other',
            }),
            scripts: ['js/video.js'],
            body: html`<div class="ovv-watch">
<div class="ovv-main">
${savedNotice(req)}${ownOnly ? notice('Private: only you (and OpenVibe staff) can see this recording.', 'info') : ''}
<div class="ovv-player-wrap"><video class="ovv-player" controls preload="metadata" playsinline src="${fileOf(vod) || ''}" data-ovv-video${nextAttr}${viewAttr}${hlsAttr}>${segs.length ? html`<track kind="captions" label="Transcript (AI)" src="/v/${id}/captions.vtt" default>` : ''}${mems.length ? html`<track kind="chapters" src="/v/${id}/chapters.vtt">` : ''}</video></div>
<h1 class="ovv-title">${vod.title || 'Stream recording'}</h1>
<div class="ovv-byline">
${channelName ? html`<a class="ovv-avatar" href="${localChannel || liveChannel}" aria-hidden="true" tabindex="-1">${String(channelName).slice(0, 1).toUpperCase()}</a>` : ''}
<div class="ovv-byline-text">${channelName ? (localChannel ? html`<a class="ovv-channel-name" href="${localChannel}">@${channelName}</a>` : html`<span class="ovv-channel-name">@${channelName}</span>`) : ''}
${metaParts.length ? html`<span class="ovv-meta">${metaParts.map((p, i) => (i === 0 ? p : [html` · `, p]))}</span>` : ''}</div>
<div class="ovv-byline-actions">${saveForm}${channelName ? html`<a class="ovv-btn" href="${liveChannel}"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Channel on OpenVibe.Live</a>` : ''}${threadUrl ? html`<a class="ovv-btn" href="${threadUrl}"><i class="fa-regular fa-comments" aria-hidden="true"></i> Discuss on OpenVibe.Community</a>` : ''}</div>
</div>
${vod.is_recording ? html`<p class="ovv-recording" role="status"><i class="fa-solid fa-circle" aria-hidden="true"></i> This recording is still in progress. <a href="${liveChannel}">Watch the live channel</a>.</p>` : ''}
${vod.ai_overview ? html`<section class="ovv-panel" aria-labelledby="h-overview"><h2 id="h-overview">About this stream</h2><p>${vod.ai_overview}</p><p class="ovv-fine">Written by AI from the stream.</p></section>` : ''}
${segs.length ? html`<details class="ovv-panel ovv-transcript"><summary>Transcript <span class="ovv-fine">(AI, ${segs.length} lines)</span></summary><div class="ovv-transcript-body">${segs.map((s) => html`<p><button type="button" class="ovv-seek" data-ovv-seek="${s.start}">${vttTime(s.start).slice(0, 8)}</button> <span>${s.text}</span></p>`)}</div></details>` : ''}
${commentsOk ? html`<section class="ovv-panel ovv-comments" aria-labelledby="h-comments"><h2 id="h-comments">Comments</h2>${commentRows.length ? commentRows.map(commentItem) : html`<p class="ovv-comments-empty">No comments yet.</p>`}${threadUrl ? html`<p class="ovv-comments-link"><a class="ovv-btn" href="${threadUrl}">Join the discussion on OpenVibe.Community</a></p>` : ''}</section>` : ''}
</div>
<aside class="ovv-side">
${manageable ? ownerPanel('vod', id, vod) : ''}
${ownOnly ? '' : clipPanel(req, id, vod)}
${up.html}
${mems.length ? html`<section class="ovv-panel ovv-chapters" aria-labelledby="h-chapters"><h2 id="h-chapters">Chapters</h2><ol>${mems.map((m) => html`<li><a href="/v/${id}?t=${m.offset_seconds}" data-ovv-chapter="${m.offset_seconds}"><span class="ovv-time">${vttTime(m.offset_seconds).slice(0, 8)}</span><span>${m.description}</span></a></li>`)}</ol><p class="ovv-fine">From the AI moments of the stream.</p></section>` : ''}
${chatRows ? html`<section class="ovv-panel ovv-chat" aria-labelledby="h-chat"><h2 id="h-chat">Chat replay</h2><div class="ovv-chat-body" data-ovv-chat>${chatRows.rows.map((r) => html`<div class="ovv-chat-row" data-ovv-at="${r.offset}"><button type="button" class="ovv-seek" data-ovv-seek="${r.offset}">${streamTime(r.offset)}</button><span class="ovv-chat-msg">${r.name ? html`<b class="ovv-chat-name">${r.name}</b> ` : ''}${r.text}</span></div>`)}</div>${chatRows.leftOut ? html`<p class="ovv-fine">Showing the first 1,000 messages; ${chatRows.leftOut} more not shown.</p>` : ''}</section>` : ''}
${clips.length ? html`<section class="ovv-panel" aria-labelledby="h-clips"><h2 id="h-clips">Clips from this stream</h2><div class="ovv-grid ovv-grid--side">${clips.map(clipCard)}</div></section>` : ''}
</aside>
</div>`,
        });
    });

    // ── Clip watch page ─────────────────────────────────────
    r.get('/c/:id', async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);

        let data = await live.clip(id);
        let ownOnly = false;
        if (!data || !data.clip) {
            data = await ownView(req, res, 'clip', id);
            ownOnly = true;
        }
        if (!data || !data.clip) return notFound(req, res);
        const clip = data.clip;
        const manageable = mayManage(req, 'clip', clip);

        let threadUrl = null;
        try {
            const cm = await live.comments('clip', id);
            threadUrl = httpsUrl(cm && cm.thread && cm.thread.url);
        } catch { threadUrl = null; }

        const unlisted = clip.visibility === 'unlisted';
        // AI clips stay out of search, as on Live: noindex and no structured data.
        const aiClip = Boolean(clip.auto_generated);
        // A clip Media is still cutting (or failed to cut) has no file to play yet.
        const cutting = Boolean(clip.status) && clip.status !== 'ready';
        if (cutting) live.forgetItem('clip', id);
        const fullRecording = clip.vod_id ? `/v/${clip.vod_id}${clip.start_time != null ? `?t=${clip.start_time}` : ''}` : null;
        const sourceName = clip.source_streamer_display_name || clip.source_streamer_username || 'the streamer';
        const madeBy = clip.display_name || clip.username || 'an OpenVibe member';
        const attribution = clip.auto_generated ? `AI clip from ${sourceName}'s stream` : `Made by ${madeBy}`;

        const saveForm = await playlistForm(req, 'clip', id);
        const up = await upNext(req, 'clip', id);
        const nextAttr = up.nextUrl ? html` data-ovv-next="${up.nextUrl}"` : '';
        const viewAttr = html` data-ovv-view="${livePublic}/api/views/clip/${id}"`;
        const hlsAttr = hlsAttrs(clip);

        return page(req, res, {
            index: !unlisted && !ownOnly && !aiClip,
            noindex: unlisted || ownOnly || aiClip,
            ...(ownOnly ? { cache: cache.htmlHeaders({ private: true }) } : {}),
            title: clip.title || 'Clip',
            description: clip.ai_overview || '',
            ...(ownOnly || aiClip ? {} : {
                jsonLd: videoLd({ base, path: `/c/${id}`, item: clip, title: clip.title || 'Clip', description: clip.ai_overview || attribution, partOf: clip.vod_id ? `/v/${clip.vod_id}` : null }),
                image: httpsUrl(clip.thumbnail_url) || undefined, ogType: 'video.other',
            }),
            scripts: ['js/video.js'],
            body: html`<div class="ovv-watch ovv-watch--clip">
<div class="ovv-main">
${savedNotice(req)}${req.query.made === '1' ? notice('Your clip was made. It is credited to you on OpenVibe.Live and here.', 'ok') : ''}${ownOnly ? notice('Private: only you (and OpenVibe staff) can see this clip.', 'info') : ''}
${cutting ? html`<div class="ovv-player-wrap ovv-cutting" role="status" data-ovv-reload="8"><p><i class="fa-solid fa-scissors" aria-hidden="true"></i> This clip is being cut. It plays here in a moment; the page checks again by itself.</p></div>`
        : html`<div class="ovv-player-wrap"><video class="ovv-player" controls preload="metadata" playsinline src="${fileOf(clip) || ''}" data-ovv-video${nextAttr}${viewAttr}${hlsAttr}></video></div>`}
<h1 class="ovv-title">${clip.title || 'Clip'}</h1>
<div class="ovv-byline">
<div class="ovv-byline-text"><span class="ovv-channel-name">${clip.auto_generated ? html`<span class="ovv-tag ovv-tag--inline">AI clip</span> ` : ''}${attribution}</span>
${clip.created_at ? html`<span class="ovv-meta"><time datetime="${clip.created_at}">${dateLabel(clip.created_at)}</time>${clip.duration_seconds != null ? html` · ${durationLabel(clip.duration_seconds)}` : ''}</span>` : ''}</div>
<div class="ovv-byline-actions">${saveForm}${fullRecording ? html`<a class="ovv-btn ovv-btn--primary" href="${fullRecording}"><i class="fa-solid fa-film" aria-hidden="true"></i> Watch in the full recording</a>` : ''}${threadUrl ? html`<a class="ovv-btn" href="${threadUrl}"><i class="fa-regular fa-comments" aria-hidden="true"></i> Discuss on OpenVibe.Community</a>` : ''}</div>
</div>
${up.html}
${clip.ai_overview ? html`<section class="ovv-panel"><p>${clip.ai_overview}</p><p class="ovv-fine">Written by AI from the clip.</p></section>` : ''}
${manageable ? ownerPanel('clip', id, clip) : ''}
</div>
</div>`,
        });
    });

    // ── Channel page ────────────────────────────────────────
    // ── Owner changes (web forms, same-origin, as the person on Live) ──
    function ownerFields(b, kind) {
        const title = String(b.title || '').trim();
        const description = String(b.description || '').trim();
        const visibility = String(b.visibility || '');
        if (!title || title.length > 200) return { error: 'A title is 1 to 200 characters.' };
        if (kind === 'vod' && description.length > 2000) return { error: 'A description is at most 2,000 characters.' };
        if (!VISIBILITIES.includes(visibility)) return { error: 'Choose public, unlisted or private.' };
        return { title, description, visibility };
    }
    const fieldError = (req, res, text, back) => page(req, res, {
        title: 'Not saved', cache: cache.htmlHeaders({ private: true }),
        body: html`<h1>That was not saved</h1>${notice(text, 'bad')}<p><a class="ovv-btn" href="${back}">Go back</a></p>`,
    }, 422);

    r.post('/v/:id/clip', mustSignIn('here', 'Sign in to make a clip.'), async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);
        const back = `/v/${id}`;
        if (!sameSite(req, res, back)) return undefined;
        const b = req.body || {};
        const start = parseClock(b.start);
        const end = parseClock(b.end);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return fieldError(req, res, 'Write the start and end as m:ss (for example 1:05) or h:mm:ss.', back);
        if (end - start < 1) return fieldError(req, res, 'The end has to come at least a second after the start.', back);
        if (end - start > CLIP_MAX_SECONDS) return fieldError(req, res, `A clip is at most ${CLIP_MAX_SECONDS} seconds.`, back);
        const title = String(b.title || '').trim().slice(0, 100);
        let out;
        try {
            out = await asPerson(req, res, (token) => live.createClip(token, { vod_id: Number(id), start_time: start, end_time: end, ...(title ? { title } : {}) }, req.ip));
        } catch (err) { return ownerRefused(req, res, err, back); }
        const clipId = out && out.clip && out.clip.id;
        live.forget('vod', id);
        return res.redirect(303, live.isId(clipId) ? `/c/${clipId}?made=1` : `${back}?saved=1`);
    });

    r.post('/v/:id/manage', mustSignIn('here', 'Sign in to manage your recording.'), async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);
        const back = `/v/${id}`;
        if (!sameSite(req, res, back)) return undefined;
        const f = ownerFields(req.body || {}, 'vod');
        if (f.error) return fieldError(req, res, f.error, back);
        try {
            await asPerson(req, res, (token) => live.updateVod(token, id, { title: f.title, description: f.description, visibility: f.visibility }));
        } catch (err) { return ownerRefused(req, res, err, back); }
        live.forget('vod', id);
        return res.redirect(303, `${back}?saved=1`);
    });

    r.post('/v/:id/delete', mustSignIn('here', 'Sign in to manage your recording.'), async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);
        const back = `/v/${id}`;
        if (!sameSite(req, res, back)) return undefined;
        if ((req.body || {}).confirm !== '1') return fieldError(req, res, 'Tick the box to confirm the deletion.', back);
        try {
            await asPerson(req, res, (token) => live.deleteVod(token, id));
        } catch (err) { return ownerRefused(req, res, err, back); }
        live.forget('vod', id);
        return res.redirect(303, req.viewer.username && live.isUsername(req.viewer.username) ? `/@${req.viewer.username}?deleted=1` : '/?deleted=1');
    });

    r.post('/c/:id/manage', mustSignIn('here', 'Sign in to manage your clip.'), async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);
        const back = `/c/${id}`;
        if (!sameSite(req, res, back)) return undefined;
        const f = ownerFields(req.body || {}, 'clip');
        if (f.error) return fieldError(req, res, f.error, back);
        // Two Live calls: the title (the clip's maker, the channel or staff) and the visibility (the channel or staff).
        // Only what changed is sent, so a maker who keeps the visibility is never refused for it.
        let current = null;
        try {
            const d = await asPerson(req, res, (token) => live.clipAs(token, id));
            current = d && d.clip;
        } catch (err) { return ownerRefused(req, res, err, back); }
        if (!current) return notFound(req, res);
        try {
            if (f.title !== String(current.title || '')) await asPerson(req, res, (token) => live.setClipTitle(token, id, f.title));
            if (f.visibility !== String(current.visibility || '')) await asPerson(req, res, (token) => live.setClipVisibility(token, id, f.visibility));
        } catch (err) { live.forget('clip', id); return ownerRefused(req, res, err, back); }
        live.forget('clip', id);
        return res.redirect(303, `${back}?saved=1`);
    });

    r.post('/c/:id/delete', mustSignIn('here', 'Sign in to manage your clip.'), async (req, res) => {
        const id = String(req.params.id || '');
        if (!live.isId(id)) return notFound(req, res);
        const back = `/c/${id}`;
        if (!sameSite(req, res, back)) return undefined;
        if ((req.body || {}).confirm !== '1') return fieldError(req, res, 'Tick the box to confirm the deletion.', back);
        try {
            await asPerson(req, res, (token) => live.deleteClip(token, id));
        } catch (err) { return ownerRefused(req, res, err, back); }
        live.forget('clip', id);
        return res.redirect(303, req.viewer.username && live.isUsername(req.viewer.username) ? `/@${req.viewer.username}?deleted=1` : '/?deleted=1');
    });

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

        let lists = [];
        if (pageNum === 1) {
            try {
                const subject = await subjectOf(username);
                if (subject) lists = (await playlists.publicByOwner(`user:${subject}`, { limit: 12 })).playlists;
            } catch (err) { log.warn('[OpenVibe.Video] channel playlists:', (err && err.message) || ''); }
        }

        const prevLink = pageNum > 1 ? `?page=${pageNum - 1}` : null;
        const nextLink = hasMore ? `?page=${pageNum + 1}` : null;
        const uploaded = pageNum === 1 ? await ctx.videoUploads.channel(username) : [];

        return page(req, res, {
            index: true,
            title: `@${username}`,
            description: `Videos, recordings and clips from @${username} on OpenVibe.Video.`,
            body: html`${req.query.deleted === '1' ? notice('Deleted on OpenVibe.Live.', 'ok') : ''}<header class="ovv-channel-head"><span class="ovv-avatar ovv-avatar--big" aria-hidden="true">${username.slice(0, 1).toUpperCase()}</span><div><h1>@${username}</h1><p class="ovv-meta">Recordings and clips from this channel's streams on OpenVibe.Live.</p></div><a class="ovv-btn" href="${livePublic}/@${username}"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Channel on OpenVibe.Live</a></header>
${uploaded.length ? html`<section class="ovv-section" aria-labelledby="h-uploads"><h2 id="h-uploads">Videos</h2>${grid(uploaded.map(uploadCard))}</section>` : ''}
<section class="ovv-section" aria-labelledby="h-vods"><h2 id="h-vods">Recordings</h2>${grid(vods.map(vodCard), 'No recordings yet.')}${prevLink || nextLink ? html`<nav class="ovv-pagination" aria-label="Pages">${prevLink ? html`<a href="${prevLink}">← Newer</a>` : ''}${nextLink ? html`<a href="${nextLink}">Older →</a>` : ''}</nav>` : ''}</section>
${clips.length ? html`<section class="ovv-section" aria-labelledby="h-clips"><h2 id="h-clips">Clips</h2>${grid(clips.map(clipCard), 'No clips yet.')}</section>` : ''}
${lists.length ? html`<section class="ovv-section" aria-labelledby="h-lists"><h2 id="h-lists">Playlists</h2><ul class="ovv-playlist-list">${lists.map(publicPlaylistRow)}</ul></section>` : ''}`,
        });
    });

    // ── Playlists ──────────────────────────────────────────
    r.get('/playlists', mustSignIn('/playlists', 'A playlist belongs to your OpenVibe account, so you can keep and share your saved recordings and clips.'), async (req, res) => {
        const rows = await playlists.list(ownerOf(req));
        if (req.viewer && req.viewer.username) await playlists.refreshOwnerUsername(ownerOf(req), req.viewer.username);
        return page(req, res, {
            title: 'Your playlists',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Playlists' }],
            body: html`<h1>Your playlists</h1>
<section class="ovv-section" aria-labelledby="h-create"><h2 id="h-create">New playlist</h2>
<form class="ovv-save-form ovv-panel" method="post" action="/playlists"><label for="new-title">Title</label> <input id="new-title" name="title" type="text" maxlength="${playlists.TITLE_MAX}" required placeholder="Watch later"> <label for="new-vis">Who can see it</label> <select id="new-vis" name="visibility">${playlists.VISIBILITIES.map((v) => html`<option value="${v}"${v === 'private' ? ' selected' : ''}>${visibilityLabel(v)}</option>`)}</select> <button class="ovv-btn ovv-btn--primary" type="submit"><i class="fa-solid fa-plus" aria-hidden="true"></i> Create</button></form></section>
<section class="ovv-section" aria-labelledby="h-lists"><h2 id="h-lists">Playlists</h2>
${rows.length ? html`<ul class="ovv-playlist-list">${rows.map(playlistRow)}</ul>` : html`<p class="muted">No playlists yet. Save a recording or clip from its watch page.</p>`}</section>`,
        });
    });

    r.post('/playlists', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, '/playlists')) return undefined;
        const out = await playlists.create(ownerOf(req), { title: (req.body || {}).title, visibility: (req.body || {}).visibility || 'private', ownerUsername: req.viewer && req.viewer.username });
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, `/playlists/${out.playlist.id}`);
    });

    r.post('/playlists/:id/rename', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, '/playlists')) return undefined;
        const out = await playlists.update(ownerOf(req), String(req.params.id || ''), { title: (req.body || {}).title });
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, '/playlists');
    });

    r.post('/playlists/:id/visibility', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, '/playlists')) return undefined;
        const out = await playlists.update(ownerOf(req), String(req.params.id || ''), { visibility: (req.body || {}).visibility });
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, '/playlists');
    });

    r.post('/playlists/:id/delete', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, '/playlists')) return undefined;
        if (String((req.body || {}).confirm || '') !== '1') {
            return page(req, res, {
                title: 'Delete playlist',
                body: html`<h1>Confirm the delete</h1>${notice('Tick the delete box to confirm.', 'warn')}<p><a class="ovv-btn" href="/playlists">Back to your playlists</a></p>`,
            }, 422);
        }
        const out = await playlists.remove(ownerOf(req), String(req.params.id || ''));
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, '/playlists');
    });

    r.post('/playlists/add', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, '/playlists')) return undefined;
        const b = req.body || {};
        const kind = String(b.kind || '');
        const id = String(b.id || '');
        const title = String(b.title || '').trim();
        const owner = ownerOf(req);
        let target = String(b.playlist || '');
        if (title) {
            const created = await playlists.create(owner, { title, ownerUsername: req.viewer && req.viewer.username });
            if (!created.ok) return playlistError(req, res, created);
            target = created.playlist.id;
        }
        const out = await playlists.addItem(owner, target, { kind, id });
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, `/playlists/${target}`);
    });

    r.get('/playlists/:id', async (req, res) => {
        const id = String(req.params.id || '');
        const pl = await playlists.get(id);
        if (!pl) return notFound(req, res);
        const isOwner = signedIn(req) && ownerOf(req) === pl.owner;
        if (pl.visibility === 'private' && !isOwner) return notFound(req, res);

        const ownerIsPerson = String(pl.owner || '').startsWith('user:');
        const ownerUsername = ownerIsPerson && pl.owner_username && live.isUsername(pl.owner_username) ? pl.owner_username : null;
        const ownerBy = ownerIsPerson
            ? (ownerUsername ? html`<a class="ovv-channel-name" href="/@${ownerUsername}">@${ownerUsername}</a>` : 'an OpenVibe member')
            : 'an app';

        const items = await playlists.items(pl.id);
        const rows = [];
        const listLd = [];
        for (const it of items) {
            const itemId = Number(it.item_id);
            let info = null;
            try {
                const data = it.kind === 'vod' ? await live.vod(itemId) : await live.clip(itemId);
                info = data && (it.kind === 'vod' ? data.vod : data.clip);
            } catch { info = null; }
            if (!info) {
                if (isOwner) rows.push(html`<li class="ovv-item-row ovv-item-row--gone"><div class="ovv-playlist-main"><span class="ovv-item-title">No longer available</span><span class="ovv-meta">${it.kind} ${itemId}</span></div>${itemControls(pl.id, it)}</li>`);
                continue;
            }
            const href = it.kind === 'vod' ? `/v/${itemId}` : `/c/${itemId}`;
            listLd.push({ '@type': 'ListItem', position: listLd.length + 1, url: `${base}${href}`, name: String(info.title || (it.kind === 'vod' ? 'Stream recording' : 'Clip')).slice(0, 110) });
            const thumb = httpsUrl(info.thumbnail_url);
            const title = info.title || (it.kind === 'clip' ? 'Clip' : 'Stream recording');
            const channel = info.username || info.display_name || null;
            const dur = info.duration_seconds != null ? info.duration_seconds : info.duration;
            rows.push(html`<li class="ovv-item-row">
<a class="ovv-item-media" href="${href}" tabindex="-1" aria-hidden="true">${thumb ? thumbImg(thumb, '132px') : html`<span class="ovv-card-placeholder"><i class="fa-solid ${it.kind === 'clip' ? 'fa-scissors' : 'fa-video'}"></i></span>`}${dur != null ? html`<span class="ovv-dur">${durationLabel(dur)}</span>` : ''}</a>
<div class="ovv-playlist-main"><a class="ovv-item-title" href="${href}">${title}</a>${channel ? html`<span class="ovv-meta">@${channel}</span>` : ''}</div>
${isOwner ? itemControls(pl.id, it) : ''}
</li>`);
        }

        const first = items[0];
        const playAllHref = first ? `${first.kind === 'vod' ? '/v/' : '/c/'}${Number(first.item_id)}?list=${encodeURIComponent(pl.id)}` : null;

        return page(req, res, {
            index: pl.visibility === 'public',
            noindex: pl.visibility === 'unlisted',
            ...(pl.visibility === 'public' && listLd.length ? { jsonLd: { '@context': 'https://schema.org', '@type': 'ItemList', name: pl.title, numberOfItems: listLd.length, itemListElement: listLd } } : {}),
            title: pl.title,
            description: pl.description || undefined,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Playlists', href: '/playlists' }, { label: pl.title }],
            body: html`<header class="ovv-playlist-head"><h1>${pl.title}</h1>
${pl.description ? html`<p class="ovv-lede">${pl.description}</p>` : ''}
<p class="ovv-meta">${visibilityLabel(pl.visibility)} · ${items.length} item${items.length === 1 ? '' : 's'} · updated ${dateLabel(pl.updated_at)}</p>
<p class="ovv-meta">Curated by ${ownerBy}</p>
${playAllHref ? html`<p><a class="ovv-btn ovv-btn--primary" href="${playAllHref}"><i class="fa-solid fa-play" aria-hidden="true"></i> Play all</a></p>` : ''}</header>
${items.length ? html`<ol class="ovv-item-list">${rows}</ol>` : html`<p class="muted">This playlist is empty.</p>`}
${isOwner ? html`<p class="ovv-fine">You can reorder items with the up and down buttons, or remove them. <a href="/playlists">Back to your playlists</a>.</p>` : ''}`,
        });
    });

    r.post('/playlists/:id/items/:kind/:itemId/up', mustSignIn('/playlists'), (req, res) => handleMove(req, res, 'up'));
    r.post('/playlists/:id/items/:kind/:itemId/down', mustSignIn('/playlists'), (req, res) => handleMove(req, res, 'down'));

    r.post('/playlists/:id/items/:kind/:itemId/remove', mustSignIn('/playlists'), async (req, res) => {
        if (!sameSite(req, res, `/playlists/${req.params.id}`)) return undefined;
        const out = await playlists.removeItem(ownerOf(req), String(req.params.id || ''), String(req.params.kind || ''), req.params.itemId);
        if (!out.ok) return playlistError(req, res, out);
        return res.redirect(303, `/playlists/${req.params.id}`);
    });

    // ── Discovery: robots.txt, sitemap.xml, llms.txt ────────
    /** Up to SITEMAP_PAGES pages of one feed, following Live's cursor; a page that fails ends the walk. */
    async function feedItems(type) {
        const items = [];
        let cursor = null;
        for (let i = 0; i < SITEMAP_PAGES; i++) {
            let page;
            try { page = await live.feed({ type, limit: SITEMAP_LIMIT, cursor }); } catch (err) { if (!items.length) throw err; break; }
            items.push(...((page && Array.isArray(page.items)) ? page.items : []));
            cursor = page && page.next;
            if (!cursor) break;
        }
        return items;
    }

    r.get('/sitemap.xml', async (req, res) => {
        const [vods, clips, uploaded] = await Promise.all([feedItems('vods'), feedItems('clips'), ctx.videoUploads.latest(500)]);
        const day = (iso) => { const d = new Date(String(iso || '')); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
        const newest = (list) => list.map(day).filter(Boolean).sort().pop() || null;
        const items = [...vods, ...clips].filter((it) => it && Number.isSafeInteger(Number(it.id)));
        const channels = new Map();   // username → its newest item's day
        for (const it of items) {
            const u = it.channel && it.channel.username;
            if (!u || !/^[A-Za-z0-9_]{1,32}$/.test(u)) continue;
            const d = day(it.created_at);
            if (!channels.has(u) || (d && d > channels.get(u))) channels.set(u, d);
        }
        for (const x of uploaded) {
            const u = x.owner_username;
            if (!u || !/^[A-Za-z0-9_]{1,32}$/.test(u)) continue;
            const d = day(x.ready_at || x.created_at);
            if (!channels.has(u) || (d && d > channels.get(u))) channels.set(u, d);
        }
        const urls = [
            { loc: `${base}/`, lastmod: newest(items.map((it) => it.created_at)) },
            { loc: `${base}/updates` },
            ...items.map((it) => ({ loc: `${base}${it.kind === 'clip' ? '/c/' : '/v/'}${Number(it.id)}`, lastmod: day(it.created_at) })),
            ...uploaded.map((x) => ({ loc: `${base}/u/${x.id}`, lastmod: day(x.updated_at) })),
            ...[...channels].map(([u, d]) => ({ loc: `${base}/@${u}`, lastmod: d })),
        ].map((u) => (u.lastmod ? u : { loc: u.loc }));
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
