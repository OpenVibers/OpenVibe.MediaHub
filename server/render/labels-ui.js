'use strict';
/**
 * Content labels on the page (L1, labels and choices; Contracts common.content-labels@1).
 *
 * What openvibe.video and OpenVibe.Pics draw for a label, server-side and without JavaScript:
 *   - attrs(): data-ov-labels on the labelled thing, which Shared's ov-labels.js (loaded by the navbar when one
 *     appears) uses to apply each viewer's own choice: show, blur behind a "Show" button, or hide. The maker always
 *     sees their own (data-ov-labels-owner: '@username' or their subject). On the thing's own page (opened), a hide
 *     covers it instead of emptying the page (openvibe-shared 4.94.0).
 *   - chips(): the labels in words beside a title, so anyone can see why a thing is covered.
 *   - picker() and fromForm(): the labels in an edit form. The AI's suggestions are marked and never ticked for the
 *     creator; nothing changes until the creator ticks one.
 * A label is a choice for viewers, never a ban: nothing here removes anything for anybody.
 */
const { html, raw } = require('./html');
const contentLabels = require('../labels');

const NAMES = Object.freeze({ nudity: 'Nudity', language: 'Strong language', graphic: 'Graphic', '18+': '18+', flashing: 'Flashing lights', spoilers: 'Spoilers' });
const HINTS = Object.freeze({
    nudity: 'Nudity, art included',
    language: 'Swearing and slurs',
    graphic: 'Blood, injury, gore',
    '18+': 'For adults only',
    flashing: 'Strobes, fast flashes',
    spoilers: 'Endings and twists',
});

/** The labels in force on a stored row or a wire item: its content_labels, or a bare labels list. */
function inForce(x) {
    if (!x || typeof x !== 'object') return [];
    const c = x.content_labels;
    // The contract's object, a jsonb string, or a bare list.
    if (c !== undefined) return contentLabels.labelsOf(Array.isArray(c) ? { labels: c } : c).labels;
    return contentLabels.labelsOf({ labels: x.labels }).labels;
}

/** The suggestions waiting for the creator (never shown to viewers). */
const suggestedOf = (x) => (x && x.content_labels && !Array.isArray(x.content_labels) ? contentLabels.labelsOf(x.content_labels).suggested : []);

const USERNAME = /^[A-Za-z0-9_]{1,32}$/;
const SUBJECT = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The maker, as ov-labels reads it: their subject from a stored owner ('user:<subject>', as Pics keeps it), a bare
 * subject (usr_…, Network's form), or '@username' from a username. Anything else is no owner.
 */
function ownerAttr(owner) {
    const s = String(owner || '');
    if (s.startsWith('user:')) return SUBJECT.test(s.slice(5)) ? s.slice(5) : null;
    if (/^usr_/.test(s) && SUBJECT.test(s)) return s;
    const name = s.startsWith('@') ? s.slice(1) : s;
    return USERNAME.test(name) ? `@${name}` : null;
}

/** ' data-ov-labels="…"' and its companions for a labelled element (nothing for none). */
function attrs(labels, { owner = null, opened = false } = {}) {
    if (!labels || !labels.length) return '';
    const who = ownerAttr(owner);
    return html` data-ov-labels="${labels.join(',')}"${who ? html` data-ov-labels-owner="${who}"` : ''}${opened ? raw(' data-ov-labels-opened') : ''}`;
}

/** The labels in words (18+ in the warning colour), as Shared's kit.labels draws them. */
function chips(labels) {
    if (!labels || !labels.length) return '';
    return html`<ul class="ovk-labels" aria-label="Content labels">${labels.map((l) => html`<li class="ovk-label${l === '18+' ? ' ovk-label--adult' : ''}" data-label="${l}">${NAMES[l]}</li>`)}</ul>`;
}

/**
 * The picker for an edit form: one toggle per label. `item` is the row or wire item (its content_labels).
 * A hidden labels_form field says the picker was there, so ticking nothing clears the labels.
 */
function picker(item, { what = 'it', id = 'labels' } = {}) {
    const now = new Set(inForce(item));
    const suggested = new Set(suggestedOf(item).filter((l) => !now.has(l)));
    return html`<fieldset class="ovl-pick" aria-describedby="${id}-help"><legend>Content labels</legend>
<p class="ovl-help" id="${id}-help">Each viewer picks what they see for a label: show it, blur it, or hide it. A label never takes ${what} down.${suggested.size ? ' AI suggested the ones marked; nothing changes until you tick one.' : ''}</p>
<input type="hidden" name="labels_form" value="1">
<div class="ovl-opts">${contentLabels.LABELS.map((l) => html`<label class="ovl-opt${l === '18+' ? ' ovl-opt--adult' : ''}"><input type="checkbox" name="labels" value="${l}"${now.has(l) ? raw(' checked') : ''}><span class="ovl-card"><b>${NAMES[l]}</b><small>${HINTS[l]}</small>${suggested.has(l) ? html`<em class="ovl-sug">Suggested</em>` : ''}</span></label>`)}</div>
</fieldset>`;
}

/**
 * The labels a submitted form asks for: a clean list, [] when the picker was there with nothing ticked, undefined when
 * the form had no picker (keep what it has), or null when it named something that is not a label.
 */
function fromForm(body) {
    const b = body || {};
    if (b.labels === undefined) return b.labels_form ? [] : undefined;
    return contentLabels.parseLabels([].concat(b.labels));
}

module.exports = { NAMES, HINTS, inForce, suggestedOf, ownerAttr, attrs, chips, picker, fromForm };
