'use strict';

/**
 * The drive's look (2026-11-07, the owner: "a competitor to Google Drive … sleek and easy to use and intuitive and
 * minimalist while being powerful"). Markup only: icons, what kind a file is, a folder tile, a file card, the
 * storage meter. pages.js decides what is on a page; this decides how each thing is drawn.
 *
 * Every control is a plain link or form, so the drive still works with JavaScript off; public/js/upload.js adds
 * drag and drop, many files at once, the upload tray, the view and sort it remembers, and the instant filter.
 */
const { html, raw } = require('../render/html');
const rules = require('./rules');

// Stroke icons on a 24-unit grid, drawn in currentColor. Paths only, so they are cheap to repeat on a long list.
const PATHS = {
    folder: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z',
    file: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5',
    doc: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M8.5 12.5h7M8.5 16h5',
    sheet: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M8.5 11.5h7v6h-7zM8.5 14.5h7M12 11.5v6',
    slides: 'M4 5h16v11H4zM12 16v4M8.5 20h7M8 9h5M8 12h8',
    image: 'M4.5 4.5h15a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1zM9 10.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5zM20.5 15.5l-5-5-10.5 9',
    video: 'M4.5 6h10a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6zM16 10.5l5-3v9l-5-3',
    audio: 'M9 17.5V6l11-2v11.5M9 17.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 15.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
    archive: 'M4 8h16v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5zM3 4h18v4H3zM10 12h4',
    code: 'M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13',
    pdf: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5M8.5 17v-4.5h1.3a1.3 1.3 0 0 1 0 2.6H8.5',
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
    'folder-plus': 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM12 11v6M9 14h6',
    sync: 'M20 11a8 8 0 0 0-14.6-4.5M4 4.5v3.8h3.8M4 13a8 8 0 0 0 14.6 4.5M20 19.5v-3.8h-3.8',
    search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M8.5 6H20M8.5 12H20M8.5 18H20M4 6h.01M4 12h.01M4 18h.01',
    more: 'M12 6.5h.01M12 12h.01M12 17.5h.01',
    download: 'M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14',
    link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2',
    pencil: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
    move: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM9 13.5h6.5M13 11l2.5 2.5L13 16',
    trash: 'M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5',
    home: 'M4 11 12 4l8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z',
    drive: 'M3.5 14.5 7 5h10l3.5 9.5M3.5 14.5h17V19a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1zM16.5 17.25h.01',
    chevron: 'M9.5 6l6 6-6 6',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    close: 'M6 6l12 12M18 6 6 18',
    lock: 'M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9.5h-13z',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.6 5.6 3.6 9S14.5 18.5 12 21c-2.5-2.5-3.6-5.6-3.6-9S9.5 5.5 12 3z',
    people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18.5 14.5a6.5 6.5 0 0 1 3 5.5',
    user: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 21a7.5 7.5 0 0 1 15 0',
};

/** One icon. Decorative unless given a label. */
const icon = (name, label = '') => raw(`<svg class="dr-i" viewBox="0 0 24 24" ${label ? `role="img" aria-label="${String(label).replace(/"/g, '&quot;')}"` : 'aria-hidden="true"'} focusable="false"><path d="${PATHS[name] || PATHS.file}"/></svg>`);

// What kind a file is, from its type and then its extension: an icon, a word for people, and a hue.
const EXT = {
    pdf: 'pdf',
    doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc', md: 'doc', pages: 'doc',
    xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet', numbers: 'sheet',
    ppt: 'slides', pptx: 'slides', odp: 'slides', key: 'slides',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', dmg: 'archive', iso: 'archive',
    js: 'code', ts: 'code', py: 'code', json: 'code', html: 'code', css: 'code', sh: 'code', go: 'code', rs: 'code', c: 'code', cpp: 'code', java: 'code', rb: 'code', php: 'code', yml: 'code', yaml: 'code', xml: 'code', sql: 'code',
};
const KINDS = {
    folder: { icon: 'folder', word: 'Folder' },
    image: { icon: 'image', word: 'Image' },
    video: { icon: 'video', word: 'Video' },
    audio: { icon: 'audio', word: 'Audio' },
    pdf: { icon: 'pdf', word: 'PDF' },
    doc: { icon: 'doc', word: 'Document' },
    sheet: { icon: 'sheet', word: 'Spreadsheet' },
    slides: { icon: 'slides', word: 'Slides' },
    archive: { icon: 'archive', word: 'Archive' },
    code: { icon: 'code', word: 'Code' },
    file: { icon: 'file', word: 'File' },
};

const extOf = (name) => ((/\.([A-Za-z0-9]{1,7})$/.exec(String(name || '')) || [])[1] || '').toLowerCase();

function kindOf(row) {
    const type = String(row.content_type || '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    if (type === 'application/pdf') return 'pdf';
    if (/zip|x-tar|x-7z|x-rar|gzip|x-bzip/.test(type)) return 'archive';
    if (/spreadsheet|ms-excel|text\/csv/.test(type)) return 'sheet';
    if (/presentation|powerpoint/.test(type)) return 'slides';
    if (/wordprocessing|msword|opendocument\.text|text\/plain|text\/markdown/.test(type)) return 'doc';
    return EXT[extOf(row.name)] || (type.startsWith('text/') ? 'doc' : 'file');
}

const kindWord = (row) => KINDS[kindOf(row)].word;

/** "Nov 7" this year, "Nov 7, 2025" before; the full time on hover. upload.js rewrites it in the reader's own zone. */
function when(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
    const text = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
    return html`<time datetime="${iso}" data-when>${text}</time>`;
}

/** The thumbnail of a file: its own picture when it is an image, else a tile in its kind's colour with its icon. */
function thumb(row, { big = false } = {}) {
    const kind = kindOf(row);
    if (rules.isPreviewable(row.content_type)) {
        return html`<span class="dr-thumb is-pic" data-kind="${kind}"><img src="/files/${row.id}/preview?w=${big ? 640 : 96}" alt="" loading="lazy" decoding="async"></span>`;
    }
    const ext = extOf(row.name);
    return html`<span class="dr-thumb" data-kind="${kind}">${icon(KINDS[kind].icon)}${ext ? html`<b>${ext.slice(0, 5)}</b>` : ''}</span>`;
}

/** A folder tile: opens on a click; its menu renames or deletes it (an empty one only). */
function folderTile(f, { count = null } = {}) {
    const href = `/files?folder=${encodeURIComponent(f.id)}`;
    return html`<li class="dr-folder" data-name="${f.name.toLowerCase()}" data-time="${f.created_at || ''}" data-size="0">
<a class="dr-folder-open" href="${href}">${icon('folder')}<span class="dr-name">${f.name}</span>${count != null ? html`<small>${count}</small>` : ''}</a>
<details class="dr-more"><summary aria-label="More for the folder ${f.name}">${icon('more')}</summary>
<div class="dr-menu">
<a href="${href}">${icon('folder')}Open</a>
<form class="dr-rename" method="post" action="/folders/${f.id}/rename"><label>${icon('pencil')}<span class="sr-only">New name for ${f.name}</span><input name="name" type="text" value="${f.name}" maxlength="${rules.FOLDER_NAME_MAX}" required></label><button type="submit">Rename</button></form>
<form method="post" action="/folders/${f.id}/delete" data-confirm="Delete the folder “${f.name}”? Only an empty folder can be deleted."><button class="is-danger" type="submit">${icon('trash')}Delete folder</button></form>
</div></details></li>`;
}

/** A file card (the grid) that is also a row (the list): the same markup, laid out by the view. */
function fileCard(row, { where = null } = {}) {
    return html`<li class="dr-file" data-name="${String(row.name).toLowerCase()}" data-time="${row.created_at || ''}" data-size="${Number(row.size) || 0}" data-kind="${kindOf(row)}">
<a class="dr-file-open" href="/files/${row.id}">${thumb(row, { big: true })}
<span class="dr-file-text"><span class="dr-name">${row.name}</span>
<span class="dr-meta"><span>${rules.formatBytes(row.size)}</span><span>${when(row.created_at)}</span>${where ? html`<span class="dr-where">${icon('folder')}${where}</span>` : ''}</span></span></a>
<details class="dr-more"><summary aria-label="More for ${row.name}">${icon('more')}</summary>
<div class="dr-menu">
<a href="/files/${row.id}/download">${icon('download')}Download</a>
<a href="/files/${row.id}#share">${icon('link')}Share a link</a>
<a href="/files/${row.id}#move">${icon('move')}Move to…</a>
<form class="dr-rename" method="post" action="/files/${row.id}/rename"><label>${icon('pencil')}<span class="sr-only">New name for ${row.name}</span><input name="name" type="text" value="${row.name}" maxlength="${rules.NAME_MAX}" required></label><button type="submit">Rename</button></form>
<form method="post" action="/files/${row.id}/delete" data-confirm="Delete “${row.name}”? Its share links stop working, and this cannot be undone."><button class="is-danger" type="submit">${icon('trash')}Delete</button></form>
</div></details></li>`;
}

/** The storage meter: a real <progress> (it means what it says without a stylesheet), the numbers beside it. */
function meter(u) {
    const pct = u.bytes_limit ? Math.min(100, Math.round((u.bytes_used / u.bytes_limit) * 100)) : 0;
    return html`<div class="dr-meter${pct >= 90 ? ' is-full' : pct >= 75 ? ' is-high' : ''}">
<p class="dr-meter-head">${icon('drive')}<span>Storage</span><b>${pct}%</b></p>
<progress id="usage" max="${u.bytes_limit}" value="${u.bytes_used}" aria-describedby="usage-text">${pct}%</progress>
<p id="usage-text" class="dr-meter-text"><b>${rules.formatBytes(u.bytes_used)}</b> of ${rules.formatBytes(u.bytes_limit)} used<br>${u.files} file${u.files === 1 ? '' : 's'} · ${u.uploads_today} of ${u.uploads_per_day} uploads today</p></div>`;
}

module.exports = { icon, kindOf, kindWord, when, thumb, folderTile, fileCard, meter, extOf, KINDS };
