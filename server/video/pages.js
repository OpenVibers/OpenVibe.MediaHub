'use strict';

/**
 * The pages of openvibe.video: public, read-only watch pages for OpenVibe.Live's stream recordings
 * (VODs) and clips. Everything here is server-rendered and complete without JavaScript; the one
 * script (public/js/video.js) only adds seeking and keeps the URL's `?t=` in step.
 *
 *   /                         what OpenVibe.Video is: who is live now, the latest uploads, the month's most watched,
 *                             the latest recordings and clips, categories and channels, how it works, questions
 *   /category/:slug           a category's recordings (OpenVibe.Search's facets over Live's recordings)
 *   /v/:id                    a VOD watch page (player, AI chapters and captions, its clips)
 *   /c/:id                    a clip watch page
 *   /@:username               a channel's recordings (and clips), newest first
 *   /v/:id/captions.vtt       the AI transcript as WebVTT captions
 *   /v/:id/chapters.vtt       the AI moments as WebVTT chapters
 *   /v/:id/download/:file     the recording, its transcript, chat replay, chapters, details or all of it as files
 *   /c/:id/download/:file     the clip, its transcript and details (server/video/downloads.js)
 *   /sitemap.xml /robots.txt /llms.txt   for the video host
 *
 * An unlisted item (visibility 'unlisted') is reachable by id but noindex and never in a list or
 * the sitemap. A private item is missing (Live already answers 404) and becomes a 404 here.
 */
const express = require('express');
const path = require('path');
const cache = require('openvibe-shared/cache-policy');
const securityTxt = require('../http/security-txt');
const seo = require('openvibe-shared/seo');
const ovServe = require('openvibe-shared/serve');
const { asyncRouter } = require('../http/router');
const { sameOrigin } = require('../http/principal');
const { html, raw, notice } = require('../render/html');
// A recording's or clip's AI overview comes from Live, which filters it; read through the same filter here too.
const { noLooks } = require('openvibe-sdk/no-looks');
const frame = require('openvibe-shared/frame');
const { send, asset, assetVersion, SITE_NAME } = require('./layout');
const { createLiveClient, LiveRefusedError } = require('./live-client');
const { createChatClient } = require('./chat-client');
const { createSearchReads, CATEGORIES, isCategory } = require('./search-reads');
const rules = require('../drive/rules');
/** 2147483648 → "2 GB" (the drive's formatBytes, without a trailing ".0"). */
const formatBytes = (b) => rules.formatBytes(b).replace(/\.0 /, ' ');
const { createVideoApiRoutes } = require('./api');
const { createUploadApi, mountUploadPages } = require('./upload-routes');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('../auth/sso');
const { mountDownloads, downloadMenu } = require('./downloads');
const { actionMenu, menuLinks, companion, whatItIs, sharePanel, lengthWords, dayLabel, streamDate } = require('./watch-ui');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const HOME_LIMIT = 10;
const MIN_HOME_SECONDS = 15;
const SITEMAP_LIMIT = 30;     // Live's feed page size (its MAX_LIMIT)
const SITEMAP_PAGES = 50;     // per kind: up to 1,500 recordings and 1,500 clips (785 and 156 public on 2026-10-20)
const SITEMAP_TTL_MS = 10 * 60 * 1000;
const THIN_SECONDS = 120;
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
// The player shows the item's picture until it plays: without a poster the page's largest paint waited for the first
// video frame (3.8 s on a phone-speed CPU, 2026-10-17). A Media thumbnail is asked for as a 1280 px WebP, as uploads are.
/**
 * The picture's shape from the first paint (owner, 2026-10-27: on a phone, a recording made upright on a phone opened in
 * a 16:9 box with wide bars, and turned only once it played). Live's stream history keeps each stream's shapes (at,
 * width, height); the one in force where this video starts is its first. Null when Live has none (streams before
 * 2026-10-25): video.js then takes the shape once it plays, as before. Clamped like video.js followShape.
 */
function startAspect(hist, vod) {
    if (!hist || !Array.isArray(hist.shapes)) return null;
    const own = Array.isArray(hist.parts) ? hist.parts.find((p) => p && String(p.vod_id) === String(vod.id)) : null;
    const from = own && Number.isFinite(Number(own.at)) ? Number(own.at) : 0;
    const shapes = hist.shapes.filter((s) => s && Number(s.width) > 0 && Number(s.height) > 0).sort((a, b) => Number(a.at) - Number(b.at));
    let pick = shapes[0] || null;
    for (const s of shapes) if (Number(s.at) <= from + 1) pick = s;
    if (!pick) return null;
    return Math.round(Math.min(3.2, Math.max(0.4, Number(pick.width) / Number(pick.height))) * 10000) / 10000;
}

function posterAttr(url) {
    // A Media thumbnail comes in sizes: the poster at 1280 px, and a 32 px preview the player shows blurred (and takes its
    // background colour from) before the poster arrives. data-ov-ambient: the picture's glow around the player.
    if (/^https:\/\/openvibe\.media\/t\/[^?#\s]+$/.test(url || '')) return html` poster="${`${url}?w=1280&fmt=webp`}" data-ov-thumb="${`${url}?w=32&fmt=webp`}" data-ov-ambient`;
    return url ? html` poster="${url}" data-ov-ambient` : '';
}

/**
 * An item's playable file. Live's `file_url` is always the file; its `playback_url` is the HLS playlist when Media has
 * one (Live T4 step 5), so it is only the fallback for answers from before `file_url` existed.
 */
function fileOf(item) {
    return httpsUrl(item.file_url) || httpsUrl(item.playback_url);
}

/**
 * The file as a crawler should fetch it. openvibe.media's /v/<id> and /c/<id> answer search engines' bots with a page
 * (link previews), Googlebot-Video included, so structured data and the video sitemap ask with ?raw=1: always the bytes.
 */
function crawlFile(url) {
    return /^https:\/\/openvibe\.media\/[vc]\/\d+$/.test(url || '') ? `${url}?raw=1` : url;
}

/**
 * A recording search engines should leave out: under two minutes with nothing written about it (no description, no AI
 * overview, under three transcript lines). On 2026-10-20, 118 of 785 public recordings were under a minute, mostly test
 * streams titled "<name>'s Channel": hundreds of near-empty pages that only dilute the site. The page still plays.
 */
function thinRecording(vod, transcriptLines = 0) {
    return !vod.description && !vod.ai_overview && transcriptLines < 3 && (Number(vod.duration_seconds) || 0) < THIN_SECONDS;
}

/** 31 → "31 seconds", 754 → "13 minutes", 7500 → "2 hours 5 minutes". */
const durationWords = lengthWords;

/**
 * A watch page's meta description when nobody wrote one, so no two pages share the site's tagline: what it is, whose,
 * how long, when, and (for a recording with a transcript) its first words, at most ~160 characters.
 */
function factualDescription(kind, item, firstWords = '') {
    const at = (u) => (/^[A-Za-z0-9_]{1,32}$/.test(String(u || '')) ? `@${u}` : null);
    const facts = [item.duration_seconds ? durationWords(item.duration_seconds) : null, dateLabel(item.created_at) || null, kind === 'vod' ? item.stream_category || null : null].filter(Boolean).join(', ');
    let lead;
    if (kind === 'vod') lead = `Stream recording${at(item.username) ? ` by ${at(item.username)}` : ''} on OpenVibe.Live`;
    else {
        const streamer = at(item.source_streamer_username);
        const maker = at(item.username);
        lead = `Clip${streamer ? ` of ${streamer}'s stream` : ''} on OpenVibe.Live${maker && maker !== streamer ? `, made by ${maker}` : ''}`;
    }
    const head = `${lead}${facts ? `: ${facts}` : ''}.`;
    const words = String(firstWords || '').replace(/\s+/g, ' ').trim();
    if (words && head.length < 120) {
        const room = 156 - head.length - 12;
        const quote = words.length > room ? `${words.slice(0, room).replace(/\s+\S*$/, '')}…` : words;
        if (quote.length > 12) return `${head} It opens: “${quote}”`;
    }
    return kind === 'vod' ? `${head} Watch with AI captions and chapters on OpenVibe.Video.` : `${head} Watch it on OpenVibe.Video.`;
}

/**
 * The player's HLS source, on the playback file's origin: Media's timeline playlist for a finished item that has one; for
 * an MP4 recording still being written, its DVR playlist over the growing file (Media /v/<id>/dvr.m3u8, Media#168), so
 * the page plays the recording without the seekable copy Media rewrote each pass. A private or WebM recording: the file.
 */
function hlsAttrs(item) {
    const file = fileOf(item);
    const hls = item.is_recording ? dvrPlaylist(item, file) : httpsUrl(item.hls_url);
    if (!hls || !file || new URL(hls).origin !== new URL(file).origin) return '';
    return html` data-ovv-hls="${hls}" data-ovv-hls-lib="${asset('vendor/hls.light.min.js')}"`;
}

/**
 * The picture-in-pictures that were on screen during a recording (Live's `vod.pips`, OpenVibe.Live
 * streaming/pip-history.js), with what public/js/video.js needs to play each over the player: its own VOD's file and
 * playlist, its window in this recording (from, to, in seconds), that VOD's second at `from`, where it starts (fractions
 * of the player), whether it starts with sound, and a link to its own page. Each PIP's VOD comes from Live's cached
 * answer (`live`, the page's Live client); one Live does not answer is left out.
 */
async function pipsOf(vod, live) {
    const list = (Array.isArray(vod.pips) ? vod.pips : []).filter((p) => p && live.isId(String(p.vod_id))
        && Number.isFinite(Number(p.from)) && Number(p.to) > Number(p.from)).slice(0, 60);
    if (!list.length) return [];
    const got = new Map();
    await Promise.all([...new Set(list.map((p) => String(p.vod_id)))].slice(0, 6).map(async (pid) => {
        try { const d = await live.vod(pid); if (d && d.vod) got.set(pid, d.vod); } catch { /* Live down: that PIP is left out */ }
    }));
    const unit = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    const out = [];
    for (const p of list) {
        const pv = got.get(String(p.vod_id));
        const file = pv && fileOf(pv);
        if (!file) continue;
        const hls = httpsUrl(pv.hls_url);
        out.push({
            file, hls: hls && new URL(hls).origin === new URL(file).origin ? hls : null,
            from: Number(p.from), to: Number(p.to), offset: Math.max(0, Number(p.offset) || 0),
            x: unit(p.x, 0, 1, 0.72), y: unit(p.y, 0, 1, 0.7), w: unit(p.w, 0.08, 0.6, 0.25), muted: p.muted !== false,
            title: String(p.title || pv.title || 'Picture-in-picture').slice(0, 120),
            href: `/v/${String(p.vod_id)}${Number(p.offset) >= 1 ? `?t=${Math.floor(Number(p.offset))}` : ''}`,
        });
    }
    return out;
}

/** The PIPs as data for the player (a JSON block: never run, so the page's CSP is untouched). */
function pipsTag(pips) {
    if (!pips.length) return '';
    return raw(`<script type="application/json" data-ovv-pips>${JSON.stringify(pips).replace(/</g, '\\u003c')}</script>`);
}

function dvrPlaylist(item, file) {
    const open = (item.visibility || (item.is_public ? 'public' : 'private')) !== 'private';
    if (!file || !open || !/\.mp4$/i.test(String(item.file_path || '')) || !Number.isSafeInteger(Number(item.id))) return null;
    return `${new URL(file).origin}/v/${Number(item.id)}/dvr.m3u8`;
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
            duration: isoDuration(item.duration_seconds), contentUrl: crawlFile(fileOf(item)) || undefined, embedUrl: pageUrl,
        }),
        ...(item.view_count != null ? { interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/WatchAction', userInteractionCount: Number(item.view_count) || 0 } } : {}),
        author: channel && item.username
            ? { '@type': 'Person', name: channel, url: `${base}/@${item.username}` }
            : { '@type': 'Organization', name: 'OpenVibe.Video', url: `${base}/` },
        creator: channel && item.username
            ? { '@type': 'Person', name: channel, url: `${base}/@${item.username}` }
            : { '@type': 'Organization', name: 'OpenVibe.Video', url: `${base}/` },
        publisher: { '@type': 'Organization', name: 'OpenVibe', url: 'https://openvibe.network' },
        ...(parts.length ? { hasPart: parts } : {}),
        ...(partOf ? { isPartOf: { '@type': 'VideoObject', url: `${base}${partOf}` } } : {}),
    };
}

// A watch page's title: streamers reuse stream titles ("Fortnite!" titled twelve different recordings' pages on
// 2026-10-17), so the channel and the day make each page's title its own in search results and browser tabs.
function watchTitle(title, who, iso) {
    const parts = [/^[A-Za-z0-9_]{1,32}$/.test(String(who || '')) ? `@${who}` : null, dateLabel(iso) || null].filter(Boolean);
    return parts.length ? `${title} (${parts.join(', ')})` : title;
}

function dateLabel(iso) {
    if (!iso) return '';
    return dayLabel(iso) || String(iso);
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

/**
 * The replay messages that belong to this recording, oldest first: at most `limit` (the panel shows 1,000; a download
 * takes them all), null when none. Times are seconds into the recording: a part of a stream recorded in parts (Live's
 * stream_offset_sec: its broadcaster reconnected) starts that much after the stream and lasts its own length.
 */
function chatMessageRows(vod, messages, limit = 1000) {
    const streamStart = utcSeconds(vod && vod.stream_started_at);
    if (!Number.isFinite(streamStart) || !Array.isArray(messages)) return null;
    // A whole recording (its parts joined, Live's recording.parts): each message at its moment in the video, the time
    // between parts left out.
    const rec = vod.recording;
    const whole = rec && rec.joined && String(rec.vod_id) === String(vod.id) && Array.isArray(rec.parts)
        ? rec.parts.filter((p) => p && p.stream_offset_sec != null && Number(p.duration_sec) > 0) : null;
    if (whole && whole.length > 1) {
        const rows = [];
        for (const m of messages) {
            if (!m || typeof m !== 'object' || m.is_deleted || m.is_filtered || m.message_type !== 'chat') continue;
            const at = utcSeconds(m.timestamp);
            if (!Number.isFinite(at)) continue;
            const s = at - streamStart;
            const p = whole.find((x) => s >= Number(x.stream_offset_sec) && s <= Number(x.stream_offset_sec) + Number(x.duration_sec) + 1);
            if (!p) continue;
            rows.push({ offset: Math.floor(Number(p.start_sec) + s - Number(p.stream_offset_sec)), name: m.display_name || m.username || '', username: m.username || '', sentAt: new Date(at * 1000).toISOString(), text: m.message == null ? '' : String(m.message) });
        }
        rows.sort((a, b) => a.offset - b.offset);
        if (!rows.length) return null;
        return { rows: rows.slice(0, limit), leftOut: rows.length > limit ? rows.length - limit : 0 };
    }
    const partAt = Number(vod.stream_offset_sec);
    const inPart = vod.stream_offset_sec != null && Number.isFinite(partAt) && partAt >= 0;
    const start = streamStart + (inPart ? partAt : 0);
    const end = inPart && Number(vod.duration_seconds) > 0 ? start + Number(vod.duration_seconds) : utcSeconds(vod.stream_ended_at);
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
        rows.push({ offset: Math.floor(offset), name: m.display_name || m.username || '', username: m.username || '', sentAt: new Date(at * 1000).toISOString(), text: m.message == null ? '' : String(m.message) });
    }
    rows.sort((a, b) => a.offset - b.offset);
    if (!rows.length) return null;
    const leftOut = rows.length > limit ? rows.length - limit : 0;
    return { rows: rows.slice(0, limit), leftOut };
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

/**
 * The AI moments as chapters: the first one, then one at least a twelfth of the stream later, at most twelve. A moment
 * with nothing seen to title it (only what was heard), or past the video's end (a stream's moments read for one part of
 * it, before Live kept parts), is no chapter: VOD 6026 listed "0:16" with no title and 41:16 in a 32-minute video.
 */
function chapters(mems, durationSeconds) {
    const length = Math.max(0, Number(durationSeconds) || 0);
    const gap = length / MAX_CHAPTERS;
    const out = [];
    for (const m of mems) {
        if (out.length >= MAX_CHAPTERS) break;
        if (length && m.offset_seconds >= length) break;
        const title = chapterTitle(m.description);
        if (!title) continue;
        if (out.length && m.offset_seconds - out[out.length - 1].offset_seconds < gap) continue;
        out.push({ offset_seconds: m.offset_seconds, description: title });
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

/** "1 view", "1,204 views": a real count from Live, or nothing. */
function viewsLabel(n) {
    const v = Number(n);
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    return `${v.toLocaleString('en-US')} ${v === 1 ? 'view' : 'views'}`;
}

function card(o) {
    const channel = o.channel ? html`<a href="${o.channelHref}">@${o.channel}</a>` : null;
    const icon = o.live ? 'fa-tower-broadcast' : (o.kind === 'clip' ? 'fa-scissors' : 'fa-video');
    return html`<article class="ovv-card">
<a class="ovv-card-media" href="${o.href}" tabindex="-1" aria-hidden="true">${o.thumb ? thumbImg(o.thumb, CARD_SIZES) : html`<span class="ovv-card-placeholder"><i class="fa-solid ${icon}"></i></span>`}${o.duration ? html`<span class="ovv-dur">${o.duration}</span>` : ''}${o.badge ? html`<span class="ovv-tag${o.live ? ' ovv-tag--live' : ''}">${o.badge}</span>` : ''}</a>
<div class="ovv-card-body">
<h3 class="ovv-card-title"><a href="${o.href}">${o.title}</a></h3>
${meta([channel, o.extra || null, o.views ? viewsLabel(o.views) : null, o.date ? html`<time datetime="${o.iso}">${o.date}</time>` : null])}
</div>
</article>`;
}

function feedCard(item, { views = false } = {}) {
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
        views: views ? item.views : null,
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
    // `unknown` is true only when Network answered that nobody has the name (not when it could not be asked).
    const subjects = new Map();   // username (lowercase) → { at, ttl, subject, unknown }
    async function identityOf(username) {
        const key = username.toLowerCase();
        const hit = subjects.get(key);
        if (hit && Date.now() - hit.at < hit.ttl) return hit;
        const r = ctx.identity && ctx.identity.lookup ? await ctx.identity.lookup(username) : { status: 'error' };
        const entry = { at: Date.now(), ttl: r.status === 'found' ? 600_000 : 60_000, subject: r.status === 'found' ? r.id : null, unknown: r.status === 'unknown' };
        subjects.delete(key);
        subjects.set(key, entry);
        if (subjects.size > 1000) subjects.delete(subjects.keys().next().value);
        return entry;
    }
    async function subjectOf(username) { return (await identityOf(username)).subject; }
    const live = createLiveClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
    const chat = createChatClient({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
    const shelves = createSearchReads({ config, fetchImpl: ctx.fetchImpl || globalThis.fetch, log });
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
    const signInPrompt = (what, next) => html`<div class="notice signin-prompt"><p>${what}</p><p><a class="ovv-btn ovv-btn--primary" href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a></p></div>`;
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
    // Who can see it, as three choices with what each means (owner, 2026-10-27: the page had no clear way to make a
    // recording private or unlisted). Radios, so the form works without JavaScript.
    const VISIBILITY_LOOK = {
        public: ['fa-solid fa-earth-americas', 'Listed and searchable'],
        unlisted: ['fa-solid fa-link', 'Only people with the link'],
        private: ['fa-solid fa-lock', 'Only you (and staff)'],
    };
    const visibilityChoices = (current) => html`<fieldset class="ovv-vis"><legend>Who can see it</legend>${VISIBILITIES.map((v) => html`<label class="ovv-vis-opt"><input type="radio" name="visibility" value="${v}"${v === current ? ' checked' : ''}><span class="ovv-vis-card"><i class="${VISIBILITY_LOOK[v][0]}" aria-hidden="true"></i><b>${visibilityLabel(v)}</b><small>${VISIBILITY_LOOK[v][1]}</small></span></label>`)}</fieldset>`;
    /** The owner's badge in the meta line: who can see it now. */
    const visibilityBadge = (v) => html`<span class="ovv-vis-badge ovv-vis-badge--${VISIBILITIES.includes(v) ? v : 'public'}"><i class="${(VISIBILITY_LOOK[v] || VISIBILITY_LOOK.public)[0]}" aria-hidden="true"></i> ${visibilityLabel(v || 'public')}</span>`;
    /** The owner's Edit button, first in the action row: opens the edit panel under the player. */
    const editButton = (what) => html`<a class="ovv-btn ovv-btn--edit" href="#manage" data-ovv-open="manage" title="Edit this ${what}: title, description, who can see it, delete"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit</a>`;
    /**
     * "Clip" in the action row: a finished recording, any signed-in viewer who can see it (Live's rule, as on Live). A
     * small form under the button; signed out, the button signs in first and comes back.
     */
    function clipAction(req, id, vod) {
        if (vod.is_recording) return '';
        if (!signedIn(req)) {
            return html`<a class="ovv-btn" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}" title="Sign in to make a clip of up to ${CLIP_MAX_SECONDS} seconds"><i class="fa-solid fa-scissors" aria-hidden="true"></i> Clip</a>`;
        }
        const dur = Math.floor(Number(vod.duration_seconds) || 0);
        // The whole video of a stream recorded in parts: its times are the video's, and a clip may cross a join.
        const whole = !!(vod.recording && vod.recording.joined && String(vod.recording.vod_id) === String(id));
        return actionMenu({ icon: 'fa-solid fa-scissors', label: 'Clip', title: `Make a clip of up to ${CLIP_MAX_SECONDS} seconds`, cls: 'ovv-clipper', body: html`<p class="ovv-pop-title">Make a clip</p>
<form class="ovv-owner-form" method="post" action="/v/${id}/clip">
${whole ? html`<input type="hidden" name="recording_time" value="1">` : ''}
<div class="ovv-clip-times">
<label class="ovv-field"><span>Start</span><input name="start" type="text" inputmode="numeric" placeholder="0:00" pattern="[0-9:.]{1,12}" required data-ovv-clip-start${dur ? html` data-ovv-clip-duration="${dur}"` : ''}></label>
<label class="ovv-field"><span>End</span><input name="end" type="text" inputmode="numeric" placeholder="0:30" pattern="[0-9:.]{1,12}" required data-ovv-clip-end></label>
</div>
<p class="ovv-clip-now" hidden data-ovv-clip-now><button type="button" class="ovv-btn ovv-btn--small" data-ovv-clip-mark="start">Start here</button> <button type="button" class="ovv-btn ovv-btn--small" data-ovv-clip-mark="end">End here</button></p>
<label class="ovv-field"><span>Title <span class="ovv-fine">(optional)</span></span><input name="title" type="text" maxlength="100" placeholder="Leave empty: AI names it" aria-describedby="ovv-clip-title-note"></label>
<p class="ovv-fine" id="ovv-clip-title-note">With no title, AI names the clip from what happens and what is said in it, a minute or so after it is cut.</p>
<p class="ovv-fine">Up to ${CLIP_MAX_SECONDS} seconds${dur ? `, within ${clock(dur)}` : ''}. Times are m:ss or h:mm:ss. It is cut on OpenVibe.Media and credited to you.</p>
<button class="ovv-btn ovv-btn--primary" type="submit">Make the clip</button>
</form>` });
    }

    function ownerPanel(kind, id, item) {
        const what = kind === 'vod' ? 'recording' : 'clip';
        const action = `/${kind === 'vod' ? 'v' : 'c'}/${id}`;
        return html`<details class="ovv-panel ovv-owner" id="manage"><summary><h2 id="h-owner"><i class="fa-solid fa-pen" aria-hidden="true"></i> Edit this ${what}</h2><span class="ovv-fine">Title, ${kind === 'vod' ? 'description, ' : ''}who can see it, delete</span></summary>
<form class="ovv-owner-form" method="post" action="${action}/manage">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="200" value="${item.title || ''}" required></label>
${kind === 'vod' ? html`<label class="ovv-field"><span>Description</span><textarea name="description" rows="3" maxlength="2000">${item.description || ''}</textarea></label>` : ''}
${visibilityChoices(item.visibility || 'public')}
<button class="ovv-btn ovv-btn--primary" type="submit">Save changes</button>
</form>
<details class="ovv-danger"><summary>Delete this ${what}</summary>
<form class="ovv-owner-delete" method="post" action="${action}/delete"><label class="ovv-confirm"><input type="checkbox" name="confirm" value="1" required> I want to delete it for good</label> <button class="ovv-btn ovv-btn--danger" type="submit">Delete</button></form>
</details>
</details>`;
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
    const uploadCard = mountUploadPages(r, { ctx, page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, visibilityOptions, visibilityLabel, durationLabel, dateLabel, httpsUrl, fileOf, hlsAttrs, grid, card, renderCaptionsVtt, renderChaptersVtt, vttTime, sendVtt, notFoundVtt, playlistForm, upNext, whatItIs, sharePanel });

    // ── Downloads: /v/:id/download/:file and /c/:id/download/:file (server/video/downloads.js) ──
    mountDownloads(r, { live, chat, ownView, asPerson, notFound, base, httpsUrl, log, fetchImpl: ctx.fetchImpl || globalThis.fetch,
        transcriptSegments, moments, chapters, chatMessageRows, renderCaptionsVtt, renderChaptersVtt });

    // ── Playlist page pieces ───────────────────────────────
    async function playlistForm(req, kind, id) {
        if (!signedIn(req)) {
            return html`<a class="ovv-btn" href="/auth/login?next=${encodeURIComponent(req.originalUrl)}" title="Sign in to save it to a playlist"><i class="fa-solid fa-plus" aria-hidden="true"></i> Save</a>`;
        }
        const lists = await playlists.list(ownerOf(req));
        return html`<details class="ovv-save ovv-pop" data-ovv-menu><summary class="ovv-btn" title="Save to a playlist"><i class="fa-solid fa-plus" aria-hidden="true"></i> Save</summary>
<form class="ovv-save-form ovv-pop-panel" method="post" action="/playlists/add">
<input type="hidden" name="kind" value="${kind}">
<input type="hidden" name="id" value="${id}">
<span class="ovv-save-label">Add to playlist</span>
<select name="playlist" aria-label="Choose a playlist or make a new one"><option value="">New playlist…</option>${lists.map((p) => html`<option value="${p.id}">${p.title}</option>`)}</select>
<input name="title" type="text" maxlength="${playlists.TITLE_MAX}" placeholder="New playlist title" aria-label="New playlist title">
<button class="ovv-btn ovv-btn--primary" type="submit">Save</button>
</form></details>`;
    }

    /**
     * What a playlist item shows and where it plays: a Live recording or clip through the cached Live client, an upload
     * from video_uploads (by its seq). Null when it is gone or nobody but its owner may watch it any more.
     */
    async function itemInfo(kind, itemId) {
        if (kind === 'upload') {
            const row = await ctx.videoUploads.bySeq(itemId);
            if (!row || row.status !== 'ready' || row.state !== 'active' || row.visibility === 'private') return null;
            return { href: `/u/${row.id}`, title: row.title, thumb: httpsUrl(row.thumbnail_url), channel: row.owner_username || null, duration: row.duration_seconds, icon: 'fa-film' };
        }
        let info = null;
        try {
            const data = kind === 'vod' ? await live.vod(itemId) : await live.clip(itemId);
            info = data && (kind === 'vod' ? data.vod : data.clip);
        } catch { info = null; }
        if (!info) return null;
        return {
            href: kind === 'vod' ? `/v/${itemId}` : `/c/${itemId}`,
            title: info.title || (kind === 'clip' ? 'Clip' : 'Stream recording'),
            thumb: httpsUrl(info.thumbnail_url),
            channel: info.username || info.display_name || null,
            duration: info.duration_seconds != null ? info.duration_seconds : info.duration,
            icon: kind === 'clip' ? 'fa-scissors' : 'fa-video',
        };
    }

    /** Where an item plays, without asking anyone (the up-next link and "Play all"). */
    async function itemHref(kind, itemId) {
        if (kind === 'upload') {
            const row = await ctx.videoUploads.bySeq(itemId);
            return row ? `/u/${row.id}` : null;
        }
        return kind === 'vod' ? `/v/${itemId}` : `/c/${itemId}`;
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
        const nextHref = await itemHref(next.kind, nextId);
        if (!nextHref) return { html: '', nextUrl: null };
        const nextUrl = `${nextHref}?list=${encodeURIComponent(pl.id)}`;
        const info = await itemInfo(next.kind, nextId);
        const label = (info && info.title) || `${next.kind === 'vod' ? 'VOD' : next.kind === 'clip' ? 'Clip' : 'Video'} ${nextId}`;
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
    // Every section is real data and hides itself when it has none: who is live on OpenVibe.Live now, the latest
    // uploads, the month's most watched, the latest recordings and clips (Live's public feed), the categories and
    // channels with their counts (OpenVibe.Search's facets over Live's recordings), then how it works and questions.
    const settle = (p) => Promise.resolve().then(() => p).catch(() => null);
    const itemsOf = (x) => ((x && Array.isArray(x.items)) ? x.items : []);
    const LIVE_THUMB = /^\/api\/thumbnails\/[A-Za-z0-9._-]{1,200}$/;
    /** Live's own streams list → cards for the ones that may be shown to everyone (not marked adult). */
    function liveCards(answer) {
        const streams = (answer && Array.isArray(answer.streams)) ? answer.streams : [];
        return streams.filter((s) => s && !s.is_nsfw && /^[A-Za-z0-9_]{1,32}$/.test(String(s.username || '')))
            .sort((a, b) => (Number(b.total_viewer_count ?? b.viewer_count) || 0) - (Number(a.total_viewer_count ?? a.viewer_count) || 0))
            .slice(0, 8)
            .map((s) => {
                const watching = Number(s.total_viewer_count ?? s.viewer_count) || 0;
                const cat = CATEGORIES[String(s.category || s.chosen_category || '')];
                const started = s.started_at ? new Date(`${String(s.started_at).replace(' ', 'T')}${/[zZ]|[+-]\d\d:?\d\d$/.test(String(s.started_at)) ? '' : 'Z'}`) : null;
                return card({
                    href: `${livePublic}/@${s.username}`, live: true, badge: 'Live',
                    thumb: LIVE_THUMB.test(String(s.thumbnail_url || '')) ? httpsUrl(`${livePublic}${s.thumbnail_url}`) : `https://openvibe.media/live/@${s.username}/frame.jpg?w=640`,
                    title: s.title || `${s.display_name || s.username} is live`,
                    channel: s.username, channelHref: `${livePublic}/@${s.username}`,
                    extra: [cat ? cat.label : null, watching > 0 ? `${watching.toLocaleString('en-US')} watching` : null].filter(Boolean).join(' · ') || null,
                    date: started && !Number.isNaN(started.getTime()) ? `started ${relativeDate(started.toISOString())}` : null,
                    iso: started && !Number.isNaN(started.getTime()) ? started.toISOString() : null,
                });
            });
    }
    // The same streams' names in the same order, for the "live now" tile's link.
    function liveNames(answer) {
        const streams = (answer && Array.isArray(answer.streams)) ? answer.streams : [];
        return streams.filter((s) => s && !s.is_nsfw && /^[A-Za-z0-9_]{1,32}$/.test(String(s.username || '')))
            .sort((a, b) => (Number(b.total_viewer_count ?? b.viewer_count) || 0) - (Number(a.total_viewer_count ?? a.viewer_count) || 0))
            .slice(0, 8).map((s) => s.username);
    }
    const n = (v) => Number(v).toLocaleString('en-US');
    const HOME_FAQ = (vu) => [
        { q: 'Is OpenVibe.Video free?', a: `Yes. Watching needs no account, and uploading needs a free OpenVibe account. Each person can upload ${vu.perDay} videos a day and keep up to ${formatBytes(vu.quotaBytes)}.` },
        { q: 'Which files can I upload?', a: `MP4 (MOV and M4V too), WebM and MKV, up to ${formatBytes(vu.maxBytes)} each. You can also record your camera or screen right in the browser.` },
        { q: 'How do streams from OpenVibe.Live get here?', a: 'When a stream on OpenVibe.Live is recorded, the recording appears here after the stream ends, on the streamer\'s channel at openvibe.video/@name, together with the clips people cut from it.' },
        { q: 'Where do the captions and chapters come from?', a: 'OpenVibe.AI turns the speech into captions, splits the video into chapters and writes a short summary. On your own uploads you can use the summary as the description.' },
        { q: 'Who can see my video?', a: 'You choose for each video: public videos show on your channel and in search, unlisted ones only to people who have the link, and private ones only to you.' },
        { q: 'Can I make a clip?', a: `Yes. Sign in, open a recording and cut a clip of up to ${CLIP_MAX_SECONDS} seconds. It gets its own watch page and shows on the channel.` },
    ];
    r.get('/', async (req, res) => {
        const [vods, clips, topVods, topClips, onAir, totals, shelf] = await Promise.all([
            live.feed({ type: 'vods', limit: HOME_LIMIT + 6 }),
            live.feed({ type: 'clips', limit: HOME_LIMIT }),
            settle(live.feed({ type: 'vods', limit: HOME_LIMIT, sort: 'top', window: 'month' })),
            settle(live.feed({ type: 'clips', limit: HOME_LIMIT, sort: 'top', window: 'month' })),
            settle(live.liveNow()),
            settle(live.totals()),
            settle(shelves.shelves()),
        ]);
        // A stream that ended seconds after it started (a test, a dropped connection) is not worth a tile on the front
        // page; it stays on its channel.
        const worthATile = (x) => !(Number(x.duration_seconds) > 0 && Number(x.duration_seconds) < MIN_HOME_SECONDS);
        const vodItems = itemsOf(vods).filter(worthATile).slice(0, HOME_LIMIT);
        const clipItems = itemsOf(clips);
        const topItems = [...itemsOf(topVods).filter(worthATile), ...itemsOf(topClips)]
            .filter((x) => Number(x.views) > 0)
            .sort((a, b) => (Number(b.views) || 0) - (Number(a.views) || 0))
            .slice(0, HOME_LIMIT);
        const uploaded = await ctx.videoUploads.latest(HOME_LIMIT);
        const onAirCards = liveCards(onAir);
        const categories = (shelf && shelf.categories) || [];
        const channels = ((shelf && shelf.channels) || []).filter((c) => c.count >= 2).slice(0, 12);
        const counts = totals || {};
        const onAirNames = liveNames(onAir);
        const liveHref = onAirNames.length === 1 ? `${livePublic}/@${onAirNames[0]}` : `${livePublic}/`;
        const stats = [
            onAirCards.length ? { value: n(onAirCards.length), label: 'live now', href: liveHref, live: true,
                title: onAirNames.length === 1 ? `Watch ${onAirNames[0]} live` : 'Everyone live on OpenVibe.Live' } : null,
            counts.vods ? { value: n(counts.vods), label: counts.vods === 1 ? 'stream recording' : 'stream recordings', href: '#recordings' } : null,
            counts.clips ? { value: n(counts.clips), label: counts.clips === 1 ? 'clip' : 'clips', href: '#clips' } : null,
            shelf && shelf.channels.length ? { value: n(shelf.channels.length), label: shelf.channels.length === 1 ? 'channel' : 'channels', href: '#channels' } : null,
            categories.length ? { value: n(categories.length), label: categories.length === 1 ? 'category' : 'categories', href: '#categories' } : null,
        ].filter(Boolean);
        const description = counts.vods && counts.clips
            ? `Watch ${n(counts.vods)} stream recordings and ${n(counts.clips)} clips from OpenVibe.Live, or upload and record your own videos, with AI captions and chapters.`
            : 'Watch stream recordings and clips from OpenVibe.Live, or upload and record your own videos, with AI captions and chapters.';
        const faq = HOME_FAQ(config.videoUploads);
        const listed = vodItems.map((it) => ({ name: it.title || 'Stream recording', url: `${base}/v/${it.id}` }));
        return page(req, res, {
            index: true,
            title: 'OpenVibe.Video: watch streams again and share your videos',
            description,
            jsonLd: [
                seo.jsonLd.website({ name: 'OpenVibe.Video', url: base, description }),
                seo.jsonLd.organization(),
                seo.jsonLd.webPage({ name: 'OpenVibe.Video', url: `${base}/`, description, siteUrl: base }),
                ...(listed.length ? [seo.jsonLd.itemList('Latest stream recordings on OpenVibe.Video', listed, { url: `${base}/` })] : []),
                seo.jsonLd.faq(faq),
            ],
            body: html`<header class="ovv-hero"><p class="ovv-eyebrow"><i class="fa-solid fa-circle-play" aria-hidden="true"></i> OpenVibe.Video</p>
<h1>Watch streams again, and share your own videos</h1>
<p class="ovv-lede">Recordings and clips of streams on OpenVibe.Live land here when the stream ends. Upload a video or record your camera or screen in the browser, and OpenVibe.AI adds captions, chapters and a summary. Everything you post plays on your channel at openvibe.video/@you.</p>
<p class="ovv-hero-actions"><a class="ovv-btn ovv-btn--primary" href="/upload"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload a video</a> <a class="ovv-btn" href="/record"><i class="fa-solid fa-video" aria-hidden="true"></i> Record in the browser</a> <a class="ovv-btn" href="${livePublic}/docs/go-live-in-your-browser"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Go live from your browser</a></p>
${searchForm()}
${stats.length ? html`<ul class="ovv-stats" role="list">${stats.map((s) => html`<li><a class="${s.live ? 'ovv-stat is-live' : 'ovv-stat'}" href="${s.href}"${s.title ? html` title="${s.title}"` : ''}><b>${s.value}</b><span>${s.live ? html`<i class="ovv-dot" aria-hidden="true"></i> ` : ''}${s.label}</span></a></li>`)}</ul>` : ''}</header>
${onAirCards.length ? html`<section class="ovv-section ovv-row" aria-labelledby="h-live"><div class="ovv-section-head"><h2 id="h-live"><span class="ovv-dot" aria-hidden="true"></span> Live now on OpenVibe.Live</h2><a href="${livePublic}/">Everyone live</a></div>${grid(onAirCards)}</section>` : ''}
${uploaded.length ? html`<section class="ovv-section ovv-row" aria-labelledby="h-uploads"><h2 id="h-uploads">Latest uploads</h2>${grid(uploaded.map(uploadCard))}</section>` : ''}
${topItems.length ? html`<section class="ovv-section ovv-row" aria-labelledby="h-top"><h2 id="h-top">Most watched this month</h2>${grid(topItems.map((it) => feedCard(it, { views: true })))}</section>` : ''}
<section class="ovv-section ovv-row" id="recordings" aria-labelledby="h-vods"><h2 id="h-vods">Latest stream recordings</h2>${grid(vodItems.map(feedCard), 'No recordings yet.')}</section>
${categories.length ? html`<section class="ovv-section" id="categories" aria-labelledby="h-cats"><h2 id="h-cats">Browse by category</h2><ul class="ovv-shelf" role="list">${categories.map((c) => html`<li><a class="ovv-shelf-tile" href="/category/${c.slug}"><i class="fa-solid ${c.icon}" aria-hidden="true"></i><span class="ovv-shelf-name">${c.label}</span><span class="ovv-shelf-count">${n(c.count)} ${c.count === 1 ? 'recording' : 'recordings'}</span></a></li>`)}</ul></section>` : ''}
<section class="ovv-section ovv-row" id="clips" aria-labelledby="h-clips"><h2 id="h-clips">Latest clips</h2>${grid(clipItems.map(feedCard), 'No clips yet.')}</section>
${channels.length ? html`<section class="ovv-section" id="channels" aria-labelledby="h-channels"><h2 id="h-channels">Channels</h2><ul class="ovv-people" role="list">${channels.map((c) => html`<li><a class="ovv-person" href="/@${c.username}"><span class="ovv-avatar" aria-hidden="true">${c.username.slice(0, 1).toUpperCase()}<img src="${config.networkUrl}/avatar/${c.username}" alt="" loading="lazy" width="42" height="42"></span><span class="ovv-person-text"><span class="ovv-person-name">@${c.username}</span><span class="ovv-person-count">${n(c.count)} ${c.count === 1 ? 'recording' : 'recordings'}</span></span></a></li>`)}</ul></section>` : ''}
<section class="ovv-section" aria-labelledby="h-how"><details class="ovv-fold"><summary><h2 id="h-how">How it works</h2><span>stream or upload, AI captions, share</span></summary><ol class="ovv-steps">
<li><h3>Stream or upload</h3><p>Go live on OpenVibe.Live from your browser and the recording comes here, or upload a file: MP4, MOV, WebM or MKV up to ${formatBytes(config.videoUploads.maxBytes)}.</p></li>
<li><h3>Let AI do the busywork</h3><p>OpenVibe.AI writes captions, chapters and a summary. On an upload, the AI cut can make an edited copy with the pauses taken out.</p></li>
<li><h3>Share it</h3><p>Every video gets a watch page and a place on your channel. Save videos to playlists, and cut clips of up to ${CLIP_MAX_SECONDS} seconds from any recording.</p></li>
</ol></details></section>
<section class="ovv-section" aria-labelledby="h-faq"><h2 id="h-faq">Questions</h2><div class="ovv-faq">${faq.map((f) => html`<details><summary>${f.q}</summary><p>${f.a}</p></details>`)}</div></section>
<section class="ovv-section" aria-labelledby="h-more"><h2 id="h-more">More on OpenVibe</h2><ul class="ovv-more" role="list">
<li><a href="${livePublic}/"><strong>OpenVibe.Live</strong><span>Go live from your browser, no OBS needed.</span></a></li>
<li><a href="${config.pics.url}/"><strong>OpenVibe.Pics</strong><span>Share and embed pictures with a link.</span></a></li>
<li><a href="${config.baseUrl}/"><strong>OpenVibe.Download</strong><span>Your files and backups, shared on your terms.</span></a></li>
<li><a href="https://openvibe.community/"><strong>OpenVibe.Community</strong><span>Forums and pastes for talking it over.</span></a></li>
</ul></section>`,
        });
    });

    // ── Categories: Live's recordings of one kind, from OpenVibe.Search, newest first ──
    r.get('/category/:slug', async (req, res) => {
        const slug = String(req.params.slug || '');
        if (!isCategory(slug)) return notFound(req, res);
        const cat = CATEGORIES[slug];
        const cursor = typeof req.query.after === 'string' ? req.query.after : null;
        const [pageOf, shelf] = await Promise.all([shelves.category(slug, cursor), settle(shelves.shelves())]);
        if (!pageOf) {
            return page(req, res, {
                title: `${cat.label} videos`, noindex: true, cache: cache.htmlHeaders({ private: true }),
                crumbs: [{ label: 'Home', href: '/' }, { label: cat.label }],
                body: html`<h1>${cat.label}</h1><p class="muted">This list cannot be read right now. Try again in a minute, or see the <a href="/">latest recordings</a>.</p>`,
            }, 503);
        }
        if (!pageOf.items.length && cursor) return notFound(req, res);
        const known = await catalogIndex();
        // A recording of a few seconds (a test, a dropped connection) is left off the shelf, as on the home page.
        const items = await Promise.all(pageOf.items.filter((x) => !(Number(x.duration_seconds) > 0 && Number(x.duration_seconds) < MIN_HOME_SECONDS)).map(async (x) => {
            let it = known.get(`vod:${x.id}`);
            if (!it) {
                const d = await settle(live.vod(String(x.id)));
                const v = d && d.vod;
                if (v && v.visibility === 'public') it = { id: x.id, kind: 'vod', title: v.title, thumbnail_url: v.thumbnail_url, duration_seconds: v.duration_seconds, created_at: v.created_at, channel: { username: v.username } };
            }
            return it || { id: x.id, kind: 'vod', title: x.title, thumbnail_url: null, duration_seconds: x.duration_seconds, created_at: x.published_at, channel: { username: x.channel } };
        }));
        const count = ((shelf && shelf.categories) || []).find((c) => c.slug === slug);
        const others = ((shelf && shelf.categories) || []).filter((c) => c.slug !== slug);
        const title = `${cat.label} stream recordings`;
        const description = `${cat.label} stream recordings from OpenVibe.Live, newest first${count ? ` (${n(count.count)} so far)` : ''}. ${cat.blurb}`.slice(0, 160);
        return page(req, res, {
            index: !cursor && items.length >= 4, noindex: Boolean(cursor) || items.length < 4,
            title, description,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Categories', href: '/#categories' }, { label: cat.label }],
            jsonLd: [
                seo.jsonLd.breadcrumbs([{ name: 'OpenVibe.Video', url: `${base}/` }, { name: cat.label, url: `${base}/category/${slug}` }]),
                seo.jsonLd.itemList(title, items.map((it) => ({ name: it.title || 'Stream recording', url: `${base}/v/${it.id}` })), { url: `${base}/category/${slug}` }),
            ],
            body: html`<header class="ovv-channel-head"><span class="ovv-avatar ovv-avatar--big" aria-hidden="true"><i class="fa-solid ${cat.icon}"></i></span><div><h1>${cat.label}</h1><p class="ovv-meta">${cat.blurb}${count ? ` ${n(count.count)} ${count.count === 1 ? 'recording' : 'recordings'}.` : ''}</p></div></header>
<section class="ovv-section" aria-label="${title}">${grid(items.map((it) => feedCard(it)), 'Nothing in this category yet.')}</section>
${pageOf.next ? html`<p class="ovv-pagination"><a class="ovv-btn" href="/category/${slug}?after=${encodeURIComponent(pageOf.next)}" rel="next">Older recordings</a></p>` : ''}
${others.length ? html`<section class="ovv-section" aria-labelledby="h-other"><h2 id="h-other">Other categories</h2><ul class="ovv-shelf" role="list">${others.map((c) => html`<li><a class="ovv-shelf-tile" href="/category/${c.slug}"><i class="fa-solid ${c.icon}" aria-hidden="true"></i><span class="ovv-shelf-name">${c.label}</span><span class="ovv-shelf-count">${n(c.count)} ${c.count === 1 ? 'recording' : 'recordings'}</span></a></li>`)}</ul></section>` : ''}`,
        });
    });

    // ── Search: words across Live's recordings and clips and Video's uploads (OpenVibe.Search), best match first ──
    // Without ?type the three kinds show their best eight each; ?type=vod|clip|video pages one kind (24 at a time, Search's
    // cursor), and recordings filter by category. Results are noindex; the empty search page is not.
    const SEARCH_KINDS = [['vod', 'Stream recordings'], ['clip', 'Clips'], ['video', 'Uploads']];
    const searchForm = (q = '') => html`<form class="ovv-search" method="get" action="/search" role="search"><label class="sr-only" for="ovv-q">Search videos</label><input id="ovv-q" name="q" type="search" value="${q}" maxlength="200" placeholder="Search recordings, clips and uploads" required><button class="ovv-btn ovv-btn--primary" type="submit"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> Search</button></form>`;
    async function searchCards(kind, items) {
        if (kind === 'video') {
            const rows = await Promise.all(items.map((x) => settle(ctx.videoUploads.byId(x.id))));
            return rows.filter((x) => x && x.visibility === 'public' && x.status === 'ready' && x.state === 'active').map((x) => uploadCard(x));
        }
        const known = await catalogIndex();
        return items.map((x) => feedCard(known.get(`${kind}:${x.id}`) || { id: x.id, kind, title: x.title, thumbnail_url: null, duration_seconds: x.duration_seconds, created_at: x.published_at, channel: { username: x.channel } }));
    }
    r.get('/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        const kind = typeof req.query.type === 'string' && shelves.KINDS[req.query.type] ? req.query.type : null;
        const category = kind === 'vod' && isCategory(req.query.category) ? String(req.query.category) : null;
        const cursor = kind && typeof req.query.after === 'string' ? req.query.after : null;
        const link = (o) => `/search?${new URLSearchParams(Object.entries({ q, ...o }).filter(([, v]) => v))}`;
        if (!q) {
            const shelf = await settle(shelves.shelves());
            const categories = (shelf && shelf.categories) || [];
            return page(req, res, {
                index: true, title: 'Search OpenVibe.Video', description: 'Search stream recordings and clips from OpenVibe.Live and videos people uploaded to OpenVibe.Video.',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Search' }],
                body: html`<h1>Search videos</h1>${searchForm()}
${categories.length ? html`<section class="ovv-section" aria-labelledby="h-cats"><h2 id="h-cats">Or browse by category</h2><ul class="ovv-shelf" role="list">${categories.map((c) => html`<li><a class="ovv-shelf-tile" href="/category/${c.slug}"><i class="fa-solid ${c.icon}" aria-hidden="true"></i><span class="ovv-shelf-name">${c.label}</span><span class="ovv-shelf-count">${n(c.count)} ${c.count === 1 ? 'recording' : 'recordings'}</span></a></li>`)}</ul></section>` : ''}`,
            });
        }
        const kinds = kind ? [kind] : SEARCH_KINDS.map(([k]) => k);
        const answers = await Promise.all(kinds.map((k) => settle(shelves.search(q, { kind: k, category: k === 'vod' ? category : null, cursor, limit: kind ? 24 : 8 }))));
        if (answers.every((a) => !a)) {
            return page(req, res, {
                title: `Search: ${q}`, noindex: true, cache: cache.htmlHeaders({ private: true }), crumbs: [{ label: 'Home', href: '/' }, { label: 'Search' }],
                body: html`<h1>Search videos</h1>${searchForm(q)}<p class="muted">Search cannot be read right now. Try again in a minute, or browse the <a href="/">latest recordings</a>.</p>`,
            }, 503);
        }
        const sections = await Promise.all(kinds.map(async (k, i) => {
            const a = answers[i];
            const label = SEARCH_KINDS.find(([x]) => x === k)[1];
            const cards = a ? await searchCards(k, a.items) : [];
            return { kind: k, label, cards, next: a && a.next, categories: (a && a.categories) || [] };
        }));
        const found = sections.some((x) => x.cards.length);
        const vod = sections.find((x) => x.kind === 'vod');
        const chips = vod && (vod.categories.length || category) ? html`<nav class="ovv-chips" aria-label="Recordings by category"><a href="${link({ type: 'vod' })}"${!category ? raw(' aria-current="true"') : ''}>All categories</a>${vod.categories.map((c) => html`<a href="${link({ type: 'vod', category: c.slug })}"${c.slug === category ? raw(' aria-current="true"') : ''}>${c.label} <span>${n(c.count)}</span></a>`)}</nav>` : '';
        const tabs = html`<nav class="ovv-chips" aria-label="What to search"><a href="${link({})}"${!kind ? raw(' aria-current="true"') : ''}>Everything</a>${SEARCH_KINDS.map(([k, label]) => html`<a href="${link({ type: k })}"${k === kind ? raw(' aria-current="true"') : ''}>${label}</a>`)}</nav>`;
        return page(req, res, {
            title: `Search: ${q}`, noindex: true, crumbs: [{ label: 'Home', href: '/' }, { label: 'Search', href: '/search' }, { label: q }],
            body: html`<h1>Results for “${q}”</h1>${searchForm(q)}${tabs}
${found ? sections.map((x) => (x.cards.length || kind ? html`<section class="ovv-section" aria-labelledby="h-${x.kind}"><div class="ovv-section-head"><h2 id="h-${x.kind}">${x.label}</h2>${!kind && x.next ? html`<a href="${link({ type: x.kind })}">More ${x.label.toLowerCase()}</a>` : ''}</div>${x.kind === 'vod' ? chips : ''}${grid(x.cards, 'Nothing matched.')}${kind && x.next ? html`<p class="ovv-pagination"><a class="ovv-btn" href="${link({ type: kind, category, after: x.next })}" rel="next">More results</a></p>` : ''}</section>` : ''))
        : html`<p class="muted">Nothing matched “${q}”${category ? ' in that category' : ''}. Try fewer or other words, or <a href="/#categories">browse by category</a>.</p>`}`,
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
        // A part of a stream recorded in parts, once the parts play as one video (Media's recording): its page is the whole
        // video's, at the second this part starts (owner, 2026-10-27: "a single vod … that seeks just fine").
        const rec = vod.recording;
        if (rec && rec.joined && live.isId(rec.vod_id) && String(rec.vod_id) !== id) {
            const t = Math.max(0, Math.floor(Number(rec.start_sec || 0) + (Number(req.query.t) > 0 ? Number(req.query.t) : 0)));
            const q = new URLSearchParams();
            if (t) q.set('t', String(t));
            if (req.query.list) q.set('list', String(req.query.list));
            return res.redirect(301, `/v/${rec.vod_id}${q.toString() ? `?${q}` : ''}`);
        }
        if (vod && vod.ai_overview) vod.ai_overview = noLooks(vod.ai_overview).trim() || null;
        const manageable = mayManage(req, 'vod', vod);
        const clips = Array.isArray(data.clips) ? data.clips.filter((c) => c && c.visibility !== 'private') : [];

        const segs = transcriptSegments(vod);
        // Chapters, comments, chat replay, the playlist form and up next do not depend on each other: asked together
        // (one after another, five services' answers in turn, the page's p95 was 581 ms on 2026-10-17).
        const fail = Symbol('failed');
        const [m, cm, replay, saveForm, up, hist] = await Promise.all([
            // A private recording's moments are Live's answer to its owner only.
            Promise.resolve().then(() => (ownOnly ? asPerson(req, res, (token) => live.vodMemoriesAs(token, id)) : live.vodMemories(id))).catch(() => fail),
            Promise.resolve().then(() => live.comments('vod', id)).catch(() => fail),
            Promise.resolve().then(() => chat.chatReplay(vod.stream_id)).catch(() => fail),
            playlistForm(req, 'vod', id),
            upNext(req, 'vod', id),
            // The stream's history: the picture's shape where this video starts, and for one part of a stream recorded in
            // parts (its broadcaster reconnected) the other parts, to move between.
            Promise.resolve().then(() => (live.isId(vod.stream_id) ? live.streamHistory(vod.stream_id) : null)).catch(() => fail),
        ]);
        let mems = [];
        try { if (m !== fail) mems = chapters(moments(m && m.memories), vod.duration_seconds); } catch { mems = []; }
        let threadUrl = null;
        let commentRows = [];
        let commentsOk = false;
        if (cm !== fail) {
            try {
                threadUrl = httpsUrl(cm && cm.thread && cm.thread.url);
                const list = Array.isArray(cm && cm.comments) ? cm.comments : [];
                commentRows = list.filter((c) => c && !c.is_deleted && !c.deleted).slice(0, 20);
                commentsOk = true;
            } catch { threadUrl = null; }
        }

        let chatRows = null;
        if (replay !== fail) {
            try { chatRows = chatMessageRows(vod, replay && Array.isArray(replay.messages) ? replay.messages : []); } catch { chatRows = null; }
        }

        const unlisted = vod.visibility === 'unlisted';
        const channelName = vod.display_name || vod.username || null;
        const localChannel = vod.username ? `/@${vod.username}` : null;
        const liveChannel = `${livePublic}/@${vod.username}`;
        const metaParts = [];
        // What this video is: a stream recording, the day it was streamed, how long it is, how many people watched it.
        // The channel is in the byline under the title and the category in the About section, so nothing is said twice.
        const what = whatItIs({
            kind: 'recording',
            streamedAt: streamDate(vod.stream_started_at),
            publishedAt: vod.created_at,
            durationSeconds: vod.duration_seconds,
            views: Number(vod.view_count) || 0,
        });
        if (manageable) metaParts.push(visibilityBadge(vod.visibility));

        const nextAttr = up.nextUrl ? html` data-ovv-next="${up.nextUrl}"` : '';
        const viewAttr = html` data-ovv-view="${livePublic}/api/views/vod/${id}"`;
        const hlsAttr = hlsAttrs(vod);
        const pips = await pipsOf(vod, live);

        const thin = thinRecording(vod, segs.length);
        const about = vod.description || vod.ai_overview || factualDescription('vod', vod, segs.slice(0, 6).map((s) => s.text).join(' '));

        // The other parts of a stream recorded in parts, in order: Part 1 · Part 2 (this one).
        // Numbered by their place in the list, each recording once: the stored part numbers repeat after a restart
        // ("Part 1 (this one) · Part 2 · Part 1", 2026-10-27).
        const seenParts = new Set();
        const parts = vod.part && hist && hist !== fail && Array.isArray(hist.parts) ? hist.parts.filter((p) => p && live.isId(p.vod_id) && !seenParts.has(String(p.vod_id)) && seenParts.add(String(p.vod_id))) : [];
        const partNav = parts.length > 1 ? html`<p class="ovv-about-parts"><i class="fa-solid fa-layer-group" aria-hidden="true"></i> The stream was recorded in ${parts.length} parts: ${parts.map((p, i) => [i ? ' · ' : '', String(p.vod_id) === id ? html`<b>Part ${i + 1} (this one)</b>` : html`<a href="/v/${p.vod_id}">Part ${i + 1}</a>`])}</p>` : '';
        const ar = hist && hist !== fail ? startAspect(hist, vod) : null;
        const shapeAttr = ar ? html` style="--ovv-ar: ${String(ar)}" data-ovv-ar="${String(ar)}"` : '';
        // The More menu: where else this lives, and the owner's tools.
        const moreItems = [];
        if (channelName) moreItems.push({ href: liveChannel, icon: 'fa-solid fa-tower-broadcast', label: 'Channel on OpenVibe.Live', hint: 'Live streams and chat' });
        if (threadUrl) moreItems.push({ href: threadUrl, icon: 'fa-regular fa-comments', label: 'Discuss on OpenVibe.Community' });
        // Chat replay, chapters and the transcript, beside the player.
        const side = companion({ kind: 'vod', id, chat: chatRows, chapters: mems, transcript: segs, long: Number(vod.duration_seconds) >= 3600 });
        return page(req, res, {
            index: !unlisted && !ownOnly && !thin,
            noindex: unlisted || ownOnly || thin,
            ...(ownOnly ? { cache: cache.htmlHeaders({ private: true }) } : {}),
            title: watchTitle(vod.title || 'Stream recording', vod.username, vod.created_at),
            description: about,
            ...(ownOnly || vod.is_recording ? {} : {
                jsonLd: videoLd({ base, path: `/v/${id}`, item: vod, title: vod.title || 'Stream recording', description: about, chapterList: mems }),
                image: httpsUrl(vod.thumbnail_url) || undefined, ogType: 'video.other',
            }),
            scripts: ['js/video.js'],
            player: true,
            body: html`<div class="ovv-watch ovv-watch--vod">
<div class="ovv-col ovv-col--main">
<div class="ovv-stage">
${savedNotice(req)}${ownOnly ? notice('Private: only you (and OpenVibe staff) can see this recording.', 'info') : ''}
<div class="ovv-player-wrap"><video class="ovv-player" data-ov-player controls preload="metadata" playsinline${posterAttr(httpsUrl(vod.thumbnail_url))}${shapeAttr} src="${fileOf(vod) || ''}" data-ovv-video${nextAttr}${viewAttr}${hlsAttr}>${segs.length ? html`<track kind="captions" label="Transcript (AI)" src="/v/${id}/captions.vtt" default>` : ''}${mems.length ? html`<track kind="chapters" src="/v/${id}/chapters.vtt">` : ''}</video>${pipsTag(pips)}</div>
<div class="ovv-head">
<h1 class="ovv-title">${vod.title || 'Stream recording'}</h1>
${what}
<div class="ovv-head-row">
<div class="ovv-byline">
${channelName ? html`<a class="ovv-avatar" href="${localChannel || liveChannel}" aria-hidden="true" tabindex="-1">${String(channelName).slice(0, 1).toUpperCase()}${live.isUsername(String(vod.username || '')) ? html`<img src="${config.networkUrl}/avatar/${vod.username}" alt="" loading="lazy">` : ''}</a>` : ''}
<div class="ovv-byline-text">${channelName ? (localChannel ? html`<a class="ovv-channel-name" href="${localChannel}">@${channelName}</a>` : html`<span class="ovv-channel-name">@${channelName}</span>`) : ''}
${metaParts.length ? html`<span class="ovv-meta">${metaParts.map((p, i) => (i === 0 ? p : [html` · `, p]))}</span>` : ''}</div>
</div>
<div class="ovv-actions">${manageable ? editButton('recording') : ''}${saveForm}${ownOnly ? '' : clipAction(req, id, vod)}${downloadMenu({ kind: 'vod', id, item: vod, has: { transcript: segs.length, chat: chatRows ? chatRows.rows.length + chatRows.leftOut : 0, chapters: mems.length } })}${sharePanel({ url: `${base}/v/${id}`, id, at: Number(req.query.t) || null })}${moreItems.length ? actionMenu({ icon: 'fa-solid fa-ellipsis', label: 'More', iconOnly: true, cls: 'ovv-more-menu', body: menuLinks(moreItems) }) : ''}</div>
</div>
${vod.is_recording ? html`<p class="ovv-recording" role="status"><i class="fa-solid fa-circle" aria-hidden="true"></i> This recording is still in progress. <a href="${liveChannel}">Watch the live channel</a>.</p>` : ''}
</div>
</div>
${manageable ? ownerPanel('vod', id, vod) : ''}
<section class="ovv-about" aria-labelledby="h-about">
<h2 id="h-about" class="ovv-about-title">About</h2>
${vod.description ? html`<p class="ovv-about-text">${vod.description}</p>` : ''}
${vod.ai_overview ? html`<p class="ovv-about-text"><span class="ovv-ai-chip">AI summary</span> ${vod.ai_overview}</p>` : ''}
${partNav}
${channelName ? html`<p class="ovv-about-from"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Streamed live on <a href="${liveChannel}">${channelName}'s OpenVibe.Live channel</a>${vod.stream_category ? html`, in ${String(vod.stream_category).charAt(0).toUpperCase()}${String(vod.stream_category).slice(1)}` : ''}.</p>` : ''}
</section>
${commentsOk ? html`<section class="ovv-panel ovv-comments" aria-labelledby="h-comments"><header class="ovv-panel-head"><h2 id="h-comments">Comments${commentRows.length ? html` <span class="ovv-count">${commentRows.length}</span>` : ''}</h2>${threadUrl ? html`<a class="ovv-panel-link" href="${threadUrl}">Discuss on OpenVibe.Community <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></a>` : ''}</header>${commentRows.length ? commentRows.map(commentItem) : html`<p class="ovv-comments-empty">No comments yet.${threadUrl ? html` <a href="${threadUrl}">Start the discussion</a>.` : ''}</p>`}</section>` : ''}
</div>
<aside class="ovv-col ovv-col--side">
${side || ''}
${up.html}
${clips.length ? html`<section class="ovv-panel ovv-clips" aria-labelledby="h-clips"><h2 id="h-clips">Clips from this stream</h2><div class="ovv-grid ovv-grid--side">${clips.map(clipCard)}</div></section>` : ''}
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
        if (clip && clip.ai_overview) clip.ai_overview = noLooks(clip.ai_overview).trim() || null;
        const manageable = mayManage(req, 'clip', clip);

        // The comment thread, the playlist form, up next and the recording this clip was cut from are asked together.
        // The source recording (the market outcomes: a clip credits its source video and links back to it): Live's own
        // answer gives its title, its channel and the day it was streamed. 'down' when Live could not be asked, null
        // when it says there is no such public recording.
        const sourceAnswer = clip.vod_id && live.isId(String(clip.vod_id))
            ? live.vod(String(clip.vod_id)).then((s) => (s && s.vod) || null).catch(() => 'down')
            : Promise.resolve('none');
        const [cm, saveForm, up, sourceVod] = await Promise.all([
            Promise.resolve().then(() => live.comments('clip', id)).catch(() => null),
            playlistForm(req, 'clip', id),
            upNext(req, 'clip', id),
            sourceAnswer,
        ]);
        let threadUrl = null;
        try { threadUrl = httpsUrl(cm && cm.thread && cm.thread.url); } catch { threadUrl = null; }

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

        // The recording this clip was cut from: its title, its channel and the moment the clip starts in it.
        const sourceWho = sourceVod && sourceVod !== 'down' ? (sourceVod.display_name || sourceVod.username) : null;
        const sourceTitle = sourceVod && sourceVod !== 'down' && sourceVod.title ? String(sourceVod.title) : null;
        const clipAt = clip.start_time != null ? clock(Number(clip.start_time)) : null;
        const clipCredit = !clip.vod_id ? ''
            : sourceVod === 'down'
                ? html`<p class="ovv-source"><i class="fa-solid fa-film" aria-hidden="true"></i> Cut from a stream recording. OpenVibe.Live did not answer just now, so its title is not shown.</p>`
                : !sourceVod
                    ? html`<p class="ovv-source"><i class="fa-solid fa-film" aria-hidden="true"></i> Cut from a stream recording that is not public any more.</p>`
                    : html`<p class="ovv-source"><i class="fa-solid fa-film" aria-hidden="true"></i> Cut from <a href="${fullRecording}">${sourceTitle || 'the recording it came from'}</a>${sourceWho ? html`, ${sourceWho}'s stream recording` : ''}${clipAt ? html`. The clip starts at ${clipAt} in it` : ''}.</p>`;
        const what = whatItIs({
            kind: 'clip',
            label: aiClip ? 'AI clip' : 'Clip',
            streamedAt: sourceVod && sourceVod !== 'down' ? streamDate(sourceVod.stream_started_at) : null,
            publishedAt: clip.created_at,
            durationSeconds: clip.duration_seconds != null ? clip.duration_seconds : clip.duration,
            views: Number(clip.view_count) || 0,
        });

        const nextAttr = up.nextUrl ? html` data-ovv-next="${up.nextUrl}"` : '';
        const viewAttr = html` data-ovv-view="${livePublic}/api/views/clip/${id}"`;
        const hlsAttr = hlsAttrs(clip);
        const segs = transcriptSegments(clip);
        const moreItems = [];
        if (clip.source_streamer_username) moreItems.push({ href: `${livePublic}/@${clip.source_streamer_username}`, icon: 'fa-solid fa-tower-broadcast', label: 'Channel on OpenVibe.Live', hint: 'Live streams and chat' });
        if (threadUrl) moreItems.push({ href: threadUrl, icon: 'fa-regular fa-comments', label: 'Discuss on OpenVibe.Community' });
        // A clip's transcript, when it has one, beside the player as on a recording.
        const side = companion({ kind: 'clip', id, chat: null, chapters: [], transcript: segs, long: false });

        return page(req, res, {
            index: !unlisted && !ownOnly && !aiClip,
            noindex: unlisted || ownOnly || aiClip,
            ...(ownOnly ? { cache: cache.htmlHeaders({ private: true }) } : {}),
            title: watchTitle(clip.title || 'Clip', clip.source_streamer_username, clip.created_at),
            description: clip.ai_overview || factualDescription('clip', clip),
            ...(ownOnly || aiClip ? {} : {
                jsonLd: videoLd({ base, path: `/c/${id}`, item: clip, title: clip.title || 'Clip', description: clip.ai_overview || factualDescription('clip', clip) || attribution, partOf: clip.vod_id ? `/v/${clip.vod_id}` : null }),
                image: httpsUrl(clip.thumbnail_url) || undefined, ogType: 'video.other',
            }),
            scripts: ['js/video.js'],
            player: true,
            body: html`<div class="ovv-watch ovv-watch--clip">
<div class="ovv-col ovv-col--main">
<div class="ovv-stage">
${savedNotice(req)}${req.query.made === '1' ? notice('Your clip was made. It is credited to you on OpenVibe.Live and here.', 'ok') : ''}${ownOnly ? notice('Private: only you (and OpenVibe staff) can see this clip.', 'info') : ''}
${cutting ? html`<div class="ovv-player-wrap ovv-cutting" role="status" data-ovv-reload="8"><p><i class="fa-solid fa-scissors" aria-hidden="true"></i> This clip is being cut. It plays here in a moment; the page checks again by itself.</p></div>`
        : html`<div class="ovv-player-wrap"><video class="ovv-player" data-ov-player controls preload="metadata" playsinline${posterAttr(httpsUrl(clip.thumbnail_url))} src="${fileOf(clip) || ''}" data-ovv-video${nextAttr}${viewAttr}${hlsAttr}></video></div>`}
<div class="ovv-head">
<h1 class="ovv-title">${clip.title || 'Clip'}</h1>
${what}
${clipCredit}
<div class="ovv-head-row">
<div class="ovv-byline"><div class="ovv-byline-text"><span class="ovv-channel-name">${clip.auto_generated ? html`<span class="ovv-tag ovv-tag--inline">AI clip</span> ` : ''}${attribution}</span>
${clip.created_at ? html`<span class="ovv-meta"><time datetime="${clip.created_at}">${dateLabel(clip.created_at)}</time>${manageable ? html` · ${visibilityBadge(clip.visibility)}` : ''}</span>` : ''}</div></div>
<div class="ovv-actions">${manageable ? editButton('clip') : ''}${fullRecording ? html`<a class="ovv-btn ovv-btn--primary" href="${fullRecording}" title="Watch the recording it was cut from, from this moment"><i class="fa-solid fa-film" aria-hidden="true"></i> Full recording</a>` : ''}${saveForm}${cutting ? '' : downloadMenu({ kind: 'clip', id, item: clip, has: { transcript: segs.length } })}${sharePanel({ url: `${base}/c/${id}`, id, at: Number(req.query.t) || null, what: 'clip' })}${moreItems.length ? actionMenu({ icon: 'fa-solid fa-ellipsis', label: 'More', iconOnly: true, cls: 'ovv-more-menu', body: menuLinks(moreItems) }) : ''}</div>
</div>
</div>
</div>
${manageable ? ownerPanel('clip', id, clip) : ''}
${clip.ai_overview ? html`<section class="ovv-about" aria-labelledby="h-about"><h2 id="h-about" class="ovv-about-title">About</h2><p class="ovv-about-text"><span class="ovv-ai-chip">AI summary</span> ${clip.ai_overview}</p></section>` : ''}
</div>
<aside class="ovv-col ovv-col--side">
${side || ''}
${up.html}
</aside>
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
            out = await asPerson(req, res, (token) => live.createClip(token, { vod_id: Number(id), start_time: start, end_time: end, ...(title ? { title } : {}),
                ...(b.recording_time === '1' ? { recording_time: 1 } : {}) }, req.ip));
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
        // A name nobody has, with nothing to show, is a 404 (it was a 200 "No recordings yet" page linking to a Live
        // channel that does not exist, 2026-10-17). Only when Network says so: if it cannot be asked, the page stays.
        if (!vods.length && !clips.length && !uploaded.length && !lists.length && (await identityOf(username).catch(() => ({}))).unknown) {
            return notFound(req, res);
        }

        return page(req, res, {
            index: true,
            title: `@${username}`,
            description: `Videos, recordings and clips from @${username} on OpenVibe.Video.`,
            body: html`${req.query.deleted === '1' ? notice('Deleted on OpenVibe.Live.', 'ok') : ''}<header class="ovv-channel-head"><span class="ovv-avatar ovv-avatar--big" aria-hidden="true">${username.slice(0, 1).toUpperCase()}<img src="${config.networkUrl}/avatar/${username}" alt="" loading="lazy"></span><div><h1>@${username}</h1><p class="ovv-meta">Recordings and clips from this channel's streams on OpenVibe.Live.</p></div><a class="ovv-btn" href="${livePublic}/@${username}"><i class="fa-solid fa-tower-broadcast" aria-hidden="true"></i> Channel on OpenVibe.Live</a></header>
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
            const info = await itemInfo(it.kind, itemId);
            if (!info) {
                if (isOwner) rows.push(html`<li class="ovv-item-row ovv-item-row--gone"><div class="ovv-playlist-main"><span class="ovv-item-title">No longer available</span><span class="ovv-meta">${it.kind} ${itemId}</span></div>${itemControls(pl.id, it)}</li>`);
                continue;
            }
            const { href, thumb, title, channel, duration: dur } = info;
            listLd.push({ '@type': 'ListItem', position: listLd.length + 1, url: `${base}${href}`, name: String(title).slice(0, 110) });
            rows.push(html`<li class="ovv-item-row">
<a class="ovv-item-media" href="${href}" tabindex="-1" aria-hidden="true">${thumb ? thumbImg(thumb, '132px') : html`<span class="ovv-card-placeholder"><i class="fa-solid ${info.icon}"></i></span>`}${dur != null ? html`<span class="ovv-dur">${durationLabel(dur)}</span>` : ''}</a>
<div class="ovv-playlist-main"><a class="ovv-item-title" href="${href}">${title}</a>${channel ? html`<span class="ovv-meta">@${channel}</span>` : ''}</div>
${isOwner ? itemControls(pl.id, it) : ''}
</li>`);
        }

        const first = items[0];
        const firstHref = first ? await itemHref(first.kind, Number(first.item_id)) : null;
        const playAllHref = firstHref ? `${firstHref}?list=${encodeURIComponent(pl.id)}` : null;

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

    /**
     * A feed item's <video:video> (openvibe-shared seo.sitemapXml): the thumbnail, title, a description (the item's own
     * text or the facts), the file (Media's bytes) and who made it. Without a thumbnail there is none.
     */
    function sitemapVideo(it) {
        const thumb = httpsUrl(it.thumbnail_url);
        if (!thumb) return null;
        const kind = it.kind === 'clip' ? 'clip' : 'vod';
        const who = it.channel && it.channel.username;
        const item = { duration_seconds: it.duration_seconds, created_at: it.created_at, username: kind === 'vod' ? who : (it.by && it.by.username) || who, source_streamer_username: who };
        const file = kind === 'clip' ? httpsUrl(it.preview_url) : `https://openvibe.media/v/${Number(it.id)}`;
        return {
            thumbnail_loc: thumb, title: it.title || (kind === 'clip' ? 'Clip' : 'Stream recording'),
            description: it.excerpt || factualDescription(kind, item),
            content_loc: crawlFile(file) || undefined, duration: it.duration_seconds, view_count: it.views,
            publication_date: isoTime(it.created_at),
            ...(who && /^[A-Za-z0-9_]{1,32}$/.test(who) ? { uploader: who, uploader_info: `${base}/@${who}` } : {}),
        };
    }

    // Live's whole public feed, walked page by page and kept ten minutes: the sitemap's list, and the thumbnails and
    // durations of the recordings a category page lists (Search's documents carry neither).
    let catalogCache = null;      // { at, vods, clips, index: Map('vod:<id>' | 'clip:<id>' → feed item) }
    let catalogRunning = null;
    function refreshCatalog() {
        if (!catalogRunning) {
            catalogRunning = Promise.all([feedItems('vods'), feedItems('clips')])
                .then(([vods, clips]) => {
                    const index = new Map();
                    for (const it of [...vods, ...clips]) {
                        if (it && Number.isSafeInteger(Number(it.id))) index.set(`${it.kind === 'clip' ? 'clip' : 'vod'}:${Number(it.id)}`, it);
                    }
                    catalogCache = { at: Date.now(), vods, clips, index };
                    return catalogCache;
                })
                .finally(() => { catalogRunning = null; });
        }
        return catalogRunning;
    }
    /** The whole catalog, waiting for a walk when there is none yet or it is old (the sitemap). */
    function catalog() {
        if (catalogCache && Date.now() - catalogCache.at < SITEMAP_TTL_MS) return Promise.resolve(catalogCache);
        return refreshCatalog();
    }
    /** What is known now, never waiting: a stale or missing catalog starts a walk in the background. */
    async function catalogIndex() {
        if (!catalogCache || Date.now() - catalogCache.at >= SITEMAP_TTL_MS) refreshCatalog().catch(() => {});
        return catalogCache ? catalogCache.index : new Map();
    }

    let sitemapCache = null;   // { at, xml }: Live's feed is walked page by page, so the answer is kept ten minutes
    r.get('/sitemap.xml', async (req, res) => {
        if (sitemapCache && Date.now() - sitemapCache.at < SITEMAP_TTL_MS) {
            return res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sitemapCache.xml);
        }
        const [{ vods, clips }, uploaded, shelf] = await Promise.all([catalog(), ctx.videoUploads.latest(500), shelves.shelves()]);
        const day = (iso) => { const d = new Date(String(iso || '')); return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); };
        const newest = (list) => list.map(day).filter(Boolean).sort().pop() || null;
        // A short recording with nothing written about it is noindex on its page (thinRecording), so it is left out here.
        const listed = vods.filter((it) => it && (it.excerpt || (Number(it.duration_seconds) || 0) >= THIN_SECONDS));
        const items = [...listed, ...clips].filter((it) => it && Number.isSafeInteger(Number(it.id)));
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
            // A category page is indexable from four recordings (as the page itself decides).
            ...((shelf && shelf.categories) || []).filter((c) => c.count >= 4).map((c) => ({ loc: `${base}/category/${c.slug}` })),
            ...items.map((it) => {
                const video = sitemapVideo(it);
                return { loc: `${base}${it.kind === 'clip' ? '/c/' : '/v/'}${Number(it.id)}`, lastmod: day(it.created_at), ...(video ? { videos: [video] } : {}) };
            }),
            ...uploaded.map((x) => ({ loc: `${base}/u/${x.id}`, lastmod: day(x.updated_at) })),
            ...[...channels].map(([u, d]) => ({ loc: `${base}/@${u}`, lastmod: d })),
        ].map((u) => (u.lastmod ? u : { ...u, lastmod: undefined }));
        sitemapCache = { at: Date.now(), xml: seo.sitemapXml(urls) };
        return res.type('application/xml').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 })).send(sitemapCache.xml);
    });

    r.get('/robots.txt', (_req, res) => {
        return res.type('text/plain').set('Cache-Control', cache.htmlHeaders({ maxAge: 3600 }))
            .send(`# openvibe.video: the public watch pages are for search and AI crawlers.\n${seo.robotsTxt({ sitemaps: [`${base}/sitemap.xml`] })}\n# Agent manifest: ${base}/.well-known/agent.json\n`);
    });
    // RFC 9116, canonical to this host (openvibe.video), not the drive's.
    r.get('/.well-known/security.txt', securityTxt.handler(base));

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
            summary: 'Videos people upload or record in the browser, and stream recordings and clips from OpenVibe.Live, each with a watch page.',
            details: 'AI captions, chapters and a summary are made for uploads (OpenVibe.AI, on OpenVibe\'s own servers) and rendered on the watch pages, as are the AI chapters and captions of stream recordings. The AI cut makes an edited copy of an upload: the pauses cut out, or a highlights reel. Uploading needs a signed-in OpenVibe account; /upload and /record.',
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
    // An unknown /api path is a JSON problem like on every other OpenVibe host (it was this page's HTML 404).
    r.use('/api', (req, res) => require('openvibe-contracts').http.sendProblem(res, 404, 'route.not_found', { detail: 'No such API route', ctx: req.ov }));
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
