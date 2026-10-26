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
 * Times read the way a player shows them (1:57, or 1:02:05 in a video an hour or longer), not 00:01:57.
 */
const { html } = require('../render/html');

/** Seconds → "1:57", or "0:01:57" when the video runs an hour or more (every time in it then lines up). */
function clockOf(seconds, long = false) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = String(n % 60).padStart(2, '0');
    return h || long ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A button of the action row that opens a menu or a small form. `body` is the panel's content (html). */
function actionMenu({ icon, label, title = null, body, cls = '', iconOnly = false }) {
    return html`<details class="ovv-pop ${cls}" data-ovv-menu><summary class="ovv-btn${iconOnly ? ' ovv-btn--icon' : ''}" title="${title || label}"${iconOnly ? html` aria-label="${label}"` : ''}><i class="${icon}" aria-hidden="true"></i>${iconOnly ? '' : html` ${label}`}</summary>
<div class="ovv-pop-panel" role="group" aria-label="${label}">${body}</div></details>`;
}

/** The More menu's rows: [{ href, icon, label, hint? }]. */
function menuLinks(items) {
    return html`<ul class="ovv-pop-list">${items.map((it) => html`<li><a href="${it.href}"${it.external ? html` rel="noopener"` : ''}${it.data ? html` ${it.data}` : ''}><i class="${it.icon}" aria-hidden="true"></i><span>${it.label}${it.hint ? html`<small>${it.hint}</small>` : ''}</span></a></li>`)}</ul>`;
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
    return html`<details class="ovv-mini" data-ovv-menu><summary class="ovv-mini-btn" title="Download the ${what}" aria-label="Download the ${what}"><i class="fa-solid fa-download" aria-hidden="true"></i></summary>
<div class="ovv-mini-menu" role="group" aria-label="Download the ${what}">
<p class="ovv-mini-head">Download the ${what}</p>
${copy ? html`<button type="button" class="ovv-mini-item" data-ovv-copy="${copy.href}" hidden><i class="fa-regular fa-copy" aria-hidden="true"></i><span><b>${copy.label}</b><small>${copy.hint}</small></span></button>` : ''}
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
function companion({ kind, id, chat, chapters, transcript, long }) {
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
            body: html`<ol class="ovv-tp-body ovv-chapter-list">${chapters.map((m) => html`<li><a href="/${kind === 'clip' ? 'c' : 'v'}/${id}?t=${m.offset_seconds}" data-ovv-chapter="${m.offset_seconds}" title="${m.description}"><span class="ovv-time">${clockOf(m.offset_seconds, long)}</span><span class="ovv-chapter-title">${m.description}</span></a></li>`)}</ol>`,
        });
    }
    if (transcript && transcript.length) {
        tabs.push({
            key: 'transcript', tab: 'Transcript', title: 'Transcript', count: transcript.length,
            note: 'Written by AI from the audio',
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
${t.search ? html`<label class="ovv-tp-search" hidden data-ovv-search-wrap><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input type="search" placeholder="Search the transcript" aria-label="Search the transcript" data-ovv-search></label>` : ''}
${t.body}
</section>`)}
</section>`;
}

module.exports = { clockOf, actionMenu, menuLinks, cornerMenu, downloadsFor, companion };
