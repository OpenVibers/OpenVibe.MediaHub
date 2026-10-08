'use strict';

/**
 * What a file, a folder, a share and a report are — on both sides of the wire. The pages (http/pages.js) and the
 * API (http/api.js) share these rules, so a form and a POST can never disagree about a name, an expiry or a report.
 *
 *   file     fil_<ULID>, an object in OpenVibe.Media, private to the person who uploaded it
 *   folder   fld_<ULID>, a name and a parent
 *   share    /s/<slug>, 24 url-safe random characters, 1 hour to 7 days, revocable, counted
 *   report   malware | illegal | copyright | other, once per person per share
 *
 * Nothing here fetches anything, and nothing here decides who may see what: that is the store's and the service's
 * job. This module is the shape of the data and the sentences people read.
 */

const ID_RE = {
    file: /^fil_[0-9A-HJKMNP-TV-Z]{26}$/,
    folder: /^fld_[0-9A-HJKMNP-TV-Z]{26}$/,
    upload: /^upl_[0-9A-HJKMNP-TV-Z]{26}$/,
    object: /^med_[0-9A-HJKMNP-TV-Z]{26}$/,
};
// 24 url-safe characters (18 random bytes): the link is the capability, so it has to be unguessable, and it is the
// only random thing in it — the share is found by slug alone.
const SLUG_RE = /^[A-Za-z0-9_-]{22,64}$/;

const isFileId = (id) => ID_RE.file.test(String(id || ''));
const isFolderId = (id) => ID_RE.folder.test(String(id || ''));
const isUploadId = (id) => ID_RE.upload.test(String(id || ''));
const isSlug = (slug) => SLUG_RE.test(String(slug || ''));

const NAME_MAX = 200;
const FOLDER_NAME_MAX = 80;

const REASONS = ['malware', 'illegal', 'copyright', 'other'];
const REASON_TEXT = {
    malware: 'malware or a virus',
    illegal: 'illegal content',
    copyright: 'copyright infringement',
    other: 'something else',
};
// Three distinct people reporting, or one report of illegal content, suspends the share at once and puts it in
// front of staff. Counting is once, when the line is crossed, so a share staff restored is not suspended again by
// the same reports.
const SUSPEND_AT_REPORTS = 3;
const SUSPEND_IMMEDIATELY = ['illegal'];

const EXPIRY_MIN_HOURS = 1;
const EXPIRY_MAX_HOURS = 7 * 24;
const EXPIRY_DEFAULT_HOURS = 7 * 24;

/** The declared content type, normalised, or null when it is not a media type at all. */
function normalizeType(value) {
    const t = String(value == null ? '' : value).split(';')[0].trim().toLowerCase();
    return /^[\w.+-]+\/[\w.+-]+$/.test(t) ? t.slice(0, 120) : null;
}

/**
 * The content types a download keeps when it is served: a short, safe list. Everything else — HTML, SVG, XML,
 * anything executable — is served as application/octet-stream, so a browser never treats an upload as a document
 * of its own. SVG is deliberately out: it is a script container wearing an image's type.
 */
function safeContentType(type) {
    const t = normalizeType(type);
    if (!t) return null;
    if (t === 'image/svg+xml' || t.startsWith('image/svg')) return null;
    if (t === 'text/plain' || t === 'application/pdf' || t === 'application/zip') return t;
    if (/^(image|audio|video)\//.test(t)) return t;
    return null;
}

/**
 * Plain text somebody typed (a report note): control characters out, nothing else touched. A note is prose — the
 * slashes in "https://…" are part of it, which is why this is not cleanName.
 */
function cleanText(value, max = 500) {
    return String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .trim()
        .slice(0, max);
}

/** A file name as it is stored: one line, no path, never empty. A name is not a path: its slashes become _ . */
function cleanName(value, max = NAME_MAX) {
    return cleanText(value, max).replace(/[\\/]+/g, '_');
}

/** The name a file gets: what the person typed, or what the browser said, or a fallback. */
function fileName(value, fallback = 'file') {
    const s = cleanName(value);
    return s || cleanName(fallback) || 'file';
}

/** A header-safe rendering of a name for Content-Disposition. */
function headerSafeName(name) {
    return String(name || 'file').replace(/["\\\r\n\t]/g, '_').slice(0, 200) || 'file';
}

/** An expiry: whole hours, clamped to the product's own range; anything unusable is the default. */
function expiryHours(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return EXPIRY_DEFAULT_HOURS;
    return Math.min(EXPIRY_MAX_HOURS, Math.max(EXPIRY_MIN_HOURS, Math.floor(n)));
}

/** A username as OpenVibe.Network writes it (lower case, 3-30 letters/digits/underscore/dash). */
const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,29}$/;
const isUsername = (value) => USERNAME_RE.test(String(value || '').trim().toLowerCase());

/** The expiry selector the share form offers, in hours. */
const EXPIRY_CHOICES = [
    { hours: 1, label: '1 hour' },
    { hours: 24, label: '1 day' },
    { hours: 72, label: '3 days' },
    { hours: 24 * 7, label: '7 days' },
];

/** "1.4 GB" — how a size is shown. Binary units, one decimal from MB up. */
function formatBytes(n) {
    const b = Number(n) || 0;
    if (b < 1024) return `${b} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = b / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = {
    ID_RE, SLUG_RE, isFileId, isFolderId, isUploadId, isSlug, isUsername,
    NAME_MAX, FOLDER_NAME_MAX, REASONS, REASON_TEXT, SUSPEND_AT_REPORTS, SUSPEND_IMMEDIATELY,
    EXPIRY_MIN_HOURS, EXPIRY_MAX_HOURS, EXPIRY_DEFAULT_HOURS, EXPIRY_CHOICES,
    normalizeType, safeContentType, cleanName, cleanText, fileName, headerSafeName, expiryHours, formatBytes,
};
