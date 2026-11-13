'use strict';

/**
 * The pieces of the watch pages' layout (owner, 2026-10-26: "perform a review on this whole page and re organize it
 * nicely and more user friendly and intuitive"):
 *
 *   actionMenu({ … })   a button in the action row that opens a small menu (More, Clip): a <details>, so it works
 *                       without JavaScript; video.js closes it on a click elsewhere or Escape and keeps it on screen
 *   cornerMenu({ … })   a panel's own download menu: one quiet icon button in the panel's corner instead of a line of
 *                       links ("these are ugly … move to a nice sleek button/menu into the corner")
 *   companion({ … })    chat replay, chapters and the transcript as one panel beside the player, as tabs (video.js
 *                       turns them on; without it the three are listed one after another, each with its heading)
 *
 *   whatItIs({ … })    the one line under a watch page's title that says what the video is: a stream recording, a clip
 *                       or an upload, when it was streamed or published, how long it is and how many people watched
 *   shareButton({ … }) the Share button: the one share sheet every OpenVibe site opens (openvibe-shared
 *                       4.114.0). The navbar fetches the sheet the first time the button is pressed; the button
 *                       itself only says what is being shared.
 *
 * Times read the way a player shows them (1:57, or 1:02:05 in a video an hour or longer), not 00:01:57.
 */
const { html, shareButton } = require('../render/html');

/** Seconds → "1:57", or "0:01:57" when the video runs an hour or more (every time in it then lines up). */
function clockOf(seconds, long = false) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = String(n % 60).padStart(2, '0');
    return h || long ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 31 → "31 seconds", 754 → "13 minutes", 7500 → "2 hours 5 minutes". */
function lengthWords(s) {
    const n = Math.max(0, Math.round(Number(s) || 0));
    if (!n) return '';
    const plural = (v, unit) => `${v} ${unit}${v === 1 ? '' : 's'}`;
    if (n < 60) return plural(n, 'second');
    if (n < 3600) return plural(Math.round(n / 60), 'minute');
    const h = Math.floor(n / 3600);
    const m = Math.round((n % 3600) / 60);
    return m ? `${plural(h, 'hour')} ${plural(m, 'minute')}` : plural(h, 'hour');
}

/** "Oct 12, 2026" for a date (a Date, an ISO string or Live's own time), in the server's timezone. */
function dayLabel(v) {
    if (!v) return '';
    const d = v instanceof Date ? v : new Date(String(v));
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A stream's own time (Live's 'YYYY-MM-DD HH:MM:SS', which is UTC) as a Date. Anything with a timezone marker in it is
 * read as it is. Null when there is no time.
 */
function streamDate(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    const iso = /[TtZz]/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t) : null;
}

/** What a kind of video is called on the page. */
const KINDS = {
    recording: { icon: 'live', label: 'Stream recording' },
    clip: { icon: 'scissors', label: 'Clip' },
    upload: { icon: 'upload', label: 'Upload' },
};

/**
 * The one line under a watch page's title that says what the video is: the kind (a stream recording, a clip or an
 * upload), when it was streamed or published, how long it is and how many people watched it.
 *
 * Every word comes from the item's own fields: the date is the stream's own start (a recording) or the moment the
 * item was made (a clip, an upload), the length is the file's, the views are the count Live keeps. A fact that is
 * not there is left out rather than guessed.
 *
 *   kind: 'recording' | 'clip' | 'upload'
 *   streamedAt: when it was streamed (a recording, or a clip's source recording)
 *   publishedAt: when it was published or cut (the item's own created_at)
 */
function whatItIs({ kind, label = null, streamedAt = null, publishedAt = null, durationSeconds = null, views = null }) {
    const k = KINDS[kind] || KINDS.recording;
    const facts = [];
    const streamed = streamedAt ? dayLabel(streamedAt) : '';
    if (streamed) facts.push(html`Streamed on <time datetime="${isoOf(streamedAt)}">${streamed}</time>`);
    else if (publishedAt) {
        const day = dayLabel(publishedAt);
        if (day) facts.push(html`${kind === 'upload' ? 'Uploaded' : kind === 'clip' ? 'Cut' : 'Published'} on <time datetime="${isoOf(publishedAt)}">${day}</time>`);
    }
    const len = lengthWords(durationSeconds);
    if (len) facts.push(len);
    const v = Number(views);
    if (Number.isSafeInteger(v) && v > 0) facts.push(`${v.toLocaleString('en-US')} ${v === 1 ? 'view' : 'views'}`);
    return html`<p class="ovv-what"><span class="ovv-what-kind"><i class="ovg-fill" data-ov-icon="${k.icon}" aria-hidden="true"></i> ${label || k.label}</span>${facts.length ? html`<span class="ovv-what-facts">${facts.map((f, i) => (i === 0 ? f : [html` · `, f]))}</span>` : ''}</p>`;
}

/** A date as the value of a <time> element's datetime. */
function isoOf(v) {
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
    return String(v == null ? '' : v);
}



/** A button of the action row that opens a menu or a small form. `body` is the panel's content (html). */
function actionMenu({ icon, label, title = null, body, cls = '', iconOnly = false }) {
    return html`<details class="ovv-pop ${cls}" data-ovv-menu><summary class="ovv-btn${iconOnly ? ' ovv-btn--icon' : ''}" title="${title || label}"${iconOnly ? html` aria-label="${label}"` : ''}><i class="ovg-fill" data-ov-icon="${icon}" aria-hidden="true"></i>${iconOnly ? '' : html` ${label}`}</summary>
<div class="ovv-pop-panel" role="group" aria-label="${label}">${body}</div></details>`;
}

/** The owner's Delete in the action row: one tap opens the question, one more deletes (the route checks confirm=1). */
function deleteAction({ action, what }) {
    return actionMenu({ icon: 'trash', label: 'Delete', title: `Delete this ${what}`, cls: 'ovv-deleter', body: html`<p class="ovv-pop-title">Delete this ${what}?</p>
<p class="ovv-fine">It goes for good: nobody can watch it again, and it cannot be brought back.</p>
<form method="post" action="${action}/delete"><input type="hidden" name="confirm" value="1"><button class="ovv-btn ovv-btn--danger" type="submit"><i class="ovg-fill" data-ov-icon="trash" aria-hidden="true"></i> Delete for good</button></form>` });
}

/** The More menu's rows: [{ href, icon, label, hint? }]. */
function menuLinks(items) {
    return html`<ul class="ovv-pop-list">${items.map((it) => html`<li><a href="${it.href}"${it.external ? html` rel="noopener"` : ''}${it.data ? html` ${it.data}` : ''}><i class="ovg-fill" data-ov-icon="${it.icon}" aria-hidden="true"></i><span>${it.label}${it.hint ? html`<small>${it.hint}</small>` : ''}</span></a></li>`)}</ul>`;
}

const FORMATS = {
    txt: { name: 'Text', ext: 'TXT' },
    srt: { name: 'Subtitles', ext: 'SRT' },
    vtt: { name: 'Web captions', ext: 'VTT' },
    csv: { name: 'Spreadsheet', ext: 'CSV' },
    json: { name: 'Data', ext: 'JSON' },
};

/**
 * A panel's download menu: a quiet icon in its corner. `items`: [{ ext, hint }] files under `${at}.${ext}`, and an
 * optional `copy` ({ label, hint, href }) shown first, only with JavaScript (it copies the file's text).
 */
function cornerMenu({ at, what, items, copy = null }) {
    return html`<details class="ovv-mini" data-ovv-menu><summary class="ovv-mini-btn" title="Download the ${what}" aria-label="Download the ${what}"><i class="ovg-fill" data-ov-icon="download" aria-hidden="true"></i></summary>
<div class="ovv-mini-menu" role="group" aria-label="Download the ${what}">
<p class="ovv-mini-head">Download the ${what}</p>
${copy ? html`<button type="button" class="ovv-mini-item" data-ovv-copy="${copy.href}" hidden><i data-ov-icon="copy" aria-hidden="true"></i><span><b>${copy.label}</b><small>${copy.hint}</small></span></button>` : ''}
${items.map((it) => html`<a class="ovv-mini-item" href="${at}.${it.ext}" download rel="nofollow"><span class="ovv-mini-ext">${FORMATS[it.ext].ext}</span><span><b>${FORMATS[it.ext].name}</b><small>${it.hint}</small></span></a>`)}
</div></details>`;
}

/** Each tab's download menu (the files /v/:id/download/… and /c/:id/download/… serve). */
function downloadsFor(kind, id, what) {
    const at = `/${kind === 'clip' ? 'c' : 'v'}/${id}/download/${what}`;
    if (what === 'transcript') {
        return cornerMenu({ at, what: 'transcript', items: [
            { ext: 'txt', hint: 'To read, with times' }, { ext: 'srt', hint: 'For video editors and players' },
            { ext: 'vtt', hint: 'For web players' }, { ext: 'json', hint: 'For programs' }] });
    }
    if (what === 'chat') {
        return cornerMenu({ at, what: 'chat replay', items: [
            { ext: 'txt', hint: 'To read, with times' }, { ext: 'csv', hint: 'Opens in Excel or Sheets' }, { ext: 'json', hint: 'For programs' }] });
    }
    return cornerMenu({ at, what: 'chapters',
        copy: { label: 'Copy for YouTube', hint: 'Paste into a video description', href: `${at}.txt` },
        items: [{ ext: 'txt', hint: 'The same lines, as a file' }, { ext: 'vtt', hint: 'A chapter track for players' }, { ext: 'json', hint: 'For programs' }] });
}

/**
 * Chat replay, chapters and transcript in one panel. `chat` = { rows, leftOut } (rows: { offset, name, text }) or
 * null; `chapters` = [{ offset_seconds, description }]; `transcript` = [{ start, text }]; `long` = the video is an
 * hour or longer. Null when there is none of the three.
 */
function companion({ kind, id, watchId = null, chat, chapters, transcript, long }) {
    // A chapter is a moment on the item's watch page: /watch?v=<watch id>&t=<seconds>, or the numbered page until it has
    // an id (which redirects). The downloads below stay the numeric routes the files are served on.
    const at = watchId ? `/watch?v=${watchId}` : `/${kind === 'clip' ? 'c' : 'v'}/${id}`;
    const tabs = [];
    if (chat && chat.rows.length) {
        const total = chat.rows.length + chat.leftOut;
        tabs.push({
            key: 'chat', tab: 'Chat', title: 'Chat replay', count: total,
            note: `${total.toLocaleString('en-US')} ${total === 1 ? 'message' : 'messages'}, in time with the video`,
            body: html`<div class="ovv-tp-body ovv-chat-body" data-ovv-chat>${chat.rows.map((r) => html`<div class="ovv-chat-row" data-ovv-at="${r.offset}"><button type="button" class="ovv-seek" data-ovv-seek="${r.offset}" title="Play from here">${clockOf(r.offset, long)}</button><span class="ovv-chat-msg">${r.name ? html`<b class="ovv-chat-name">${r.name}</b> ` : ''}${r.text}</span></div>`)}${chat.leftOut ? html`<p class="ovv-tp-more">The first ${chat.rows.length.toLocaleString('en-US')} messages are shown here; the download has all ${total.toLocaleString('en-US')}.</p>` : ''}</div>`,
        });
    }
    if (chapters && chapters.length) {
        tabs.push({
            key: 'chapters', tab: 'Chapters', title: 'Chapters', count: chapters.length,
            note: 'Made by AI from the stream',
            body: html`<ol class="ovv-tp-body ovv-chapter-list">${chapters.map((m) => html`<li><a href="${at}?t=${m.offset_seconds}" data-ovv-chapter="${m.offset_seconds}" title="${m.description}"><span class="ovv-time">${clockOf(m.offset_seconds, long)}</span><span class="ovv-chapter-title">${m.description}</span></a></li>`)}</ol>`,
        });
    }
    if (transcript && transcript.length) {
        tabs.push({
            key: 'transcript', tab: 'Transcript', title: 'Transcript', count: transcript.length,
            note: 'Written by AI from the audio — it can be wrong',
            search: true,
            body: html`<div class="ovv-tp-body ovv-transcript-body" data-ovv-transcript>${transcript.map((s) => html`<p class="ovv-line" data-ovv-at="${Math.floor(s.start)}"><button type="button" class="ovv-seek" data-ovv-seek="${s.start}" title="Play from here">${clockOf(s.start, long)}</button> <span>${s.text}</span></p>`)}<p class="ovv-tp-empty" hidden data-ovv-search-empty>No line has that.</p></div>`,
        });
    }
    if (!tabs.length) return null;
    const one = tabs.length === 1;
    return html`<section class="ovv-companion${one ? ' ovv-companion--one' : ''}" data-ovv-tabs aria-label="${tabs.map((t) => t.title).join(', ')}">
${one ? '' : html`<div class="ovv-tabs" role="tablist" aria-label="${tabs.map((t) => t.title).join(', ')}" hidden data-ovv-tablist>${tabs.map((t, i) => html`<button type="button" role="tab" id="ovv-tab-${t.key}" aria-controls="ovv-tp-${t.key}" aria-selected="${i === 0 ? 'true' : 'false'}" tabindex="${i === 0 ? '0' : '-1'}" data-ovv-tab="${t.key}">${t.tab} <span class="ovv-tab-count">${t.count > 999 ? '999+' : t.count}</span></button>`)}</div>`}
${tabs.map((t) => html`<section class="ovv-tp" id="ovv-tp-${t.key}"${one ? '' : html` role="tabpanel" aria-labelledby="ovv-tab-${t.key}"`} data-ovv-tp="${t.key}">
<header class="ovv-tp-head"><div class="ovv-tp-heading"><h2 class="ovv-tp-title">${t.title}</h2><span class="ovv-tp-note">${t.note}</span></div>${downloadsFor(kind, id, t.key)}</header>
${t.search ? html`<label class="ovv-tp-search" hidden data-ovv-search-wrap><i class="ovg-fill" data-ov-icon="search" aria-hidden="true"></i><input type="search" placeholder="Search the transcript" aria-label="Search the transcript" data-ovv-search></label>` : ''}
${t.body}
</section>`)}
</section>`;
}

module.exports = { clockOf, lengthWords, dayLabel, streamDate, whatItIs, shareButton, actionMenu, deleteAction, menuLinks, cornerMenu, downloadsFor, companion };
