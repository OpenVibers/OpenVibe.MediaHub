'use strict';

/** Escaping and small building blocks for server-rendered pages. Everything dynamic goes through esc(). */

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tagged template: interpolations are escaped unless wrapped in raw(). Arrays are joined. */
class Raw { constructor(s) { this.s = String(s); } toString() { return this.s; } }
const raw = (s) => new Raw(s);
function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => {
        out += render(v) + strings[i + 1];
    });
    return raw(out);
}
function render(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(render).join('');
    return esc(v);
}

const kit = require('openvibe-shared/kit');

const code = (s) => html`<code>${s}</code>`;

/**
 * The Share button: the one share sheet every OpenVibe site opens (openvibe-shared 4.114.0). The navbar fetches
 * the sheet the first time the button is pressed, so the button itself only says what is being shared:
 *
 *   url:      the page's own public address — the link that is shared
 *   title:    what the thing is called
 *   text:     a line sent with it (the thing's own summary)
 *   image:    a picture of it (a thumbnail), for the places that take one
 *   timeFrom: the player whose moment can be shared (a selector), so the sheet can offer "Start at …"
 *
 * Nothing is stored and no clip is made: a moment is the page's own address with a time on it.
 */
// A caller with no class of its own gets the kit's quiet button (kit.css is on every page that shows one): an empty class
// drew an unstyled grey box beside the row's buttons (11-07).
function shareButton({ url = '', title = '', text = '', image = '', timeFrom = null, kind = null, id = null, cls = 'ovk-btn ovk-btn--quiet', label = 'Share', icon = 'fa-solid fa-share-nodes' }) {
    const line = String(text || '').trim().replace(/\s+/g, ' ');
    const summary = line.length > 240 ? `${line.slice(0, 237).trimEnd()}…` : line;
    return html`<button type="button" class="${cls}" data-ov-share-sheet${url ? html` data-url="${url}"` : ''}${title ? html` data-title="${title}"` : ''}${summary ? html` data-text="${summary}"` : ''}${image ? html` data-image="${image}"` : ''}${timeFrom ? html` data-time-from="${timeFrom}"` : ''}${kind && id ? html` data-kind="${kind}" data-id="${id}"` : ''}><i class="${icon}" aria-hidden="true"></i> ${label}</button>`;
}
const time = (iso) => (iso ? html`<time datetime="${iso}">${String(iso).replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC')}</time>` : '—');

/** A <table> from headers and rows of cells (cells are already html or plain values). Each cell names its column
 *  (data-label), so on a phone a wide table can show each row as a card (the site's stylesheet). */
function table(headers, rows, { cls = '', empty = 'Nothing here yet.' } = {}) {
    if (!rows.length) return html`<p class="muted">${empty}</p>`;
    return html`<div class="table-wrap"><table class="${cls}"><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => (typeof headers[i] === 'string' && headers[i] ? html`<td data-label="${headers[i]}">${c}</td>` : html`<td>${c}</td>`))}</tr>`)}</tbody></table></div>`;
}

/** A problem as returned by Network, Events or Media — shown as it came, never softened. */
function problemBox(p, { title = 'The request failed' } = {}) {
    if (!p) return '';
    return html`<div class="problem" role="alert"><strong>${title}</strong>
<p>${p.detail || 'No detail was given.'}</p>
<p class="muted small">HTTP ${p.status || '—'} · <code>${p.code || 'unknown'}</code>${p.requestId ? html` · request <code>${p.requestId}</code>` : ''}</p></div>`;
}

const notice = (text, kind = 'info') => html`<div class="notice ${kind}" role="status">${text}</div>`;
const csrfField = (token) => html`<input type="hidden" name="csrf" value="${token}">`;
const badge = (text, kind = '') => html`<span class="badge ${kind}">${text}</span>`;

module.exports = { esc, html, raw, Raw, render, code, time, table, problemBox, notice, csrfField, badge, shareButton };
