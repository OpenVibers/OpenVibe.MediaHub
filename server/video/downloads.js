'use strict';

/**
 * Downloads on openvibe.video: everything a recording's or clip's page shows, as files to keep (owner, 2026-10-26: "add
 * easy and intuitive ways for downloading stuff like the transcripts, chat replay, chapters, etc … in a user friendly
 * way across the different file types and maybe have a generic download button").
 *
 *   /v/:id/download/<file>   video · thumbnail · transcript.{txt,srt,vtt,json} · chat.{txt,csv,json}
 *                            · chapters.{txt,vtt,json} · info.json · all.zip
 *   /c/:id/download/<file>   video · thumbnail · transcript.{txt,srt,vtt,json} · info.json · all.zip
 *
 * The watch page's Download button lists what this item has, each in the formats people use it in (text to read, SRT
 * and WebVTT for video editors and players, CSV for spreadsheets, JSON for programs, chapters as the lines a YouTube
 * description takes), and each panel (transcript, chapters, chat replay) carries its own links. Every file is named
 * "<title> - <channel> - <date>.<what>.<ext>". The video itself is OpenVibe.Media's file, sent as an attachment
 * (Live's download-url: signed for a private item's owner); "Everything" is one .zip of the rest (not the video).
 *
 * Who may download is who may see the page: a public or unlisted item for anyone, a private one for its owner (and
 * staff), read from Live as them exactly like the page.
 */
const zlib = require('zlib');
const { html } = require('../render/html');

const FILE_NAME_MAX = 120;
const THUMB_MAX_BYTES = 10 * 1024 * 1024;
const FETCH_MS = 8000;

// ── Names and times ────────────────────────────────────────
/** A file name part: no control, quote or path characters, spaces collapsed. */
function cleanPart(s) {
    return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "<title> - <channel> - <YYYY-MM-DD>", at most FILE_NAME_MAX characters (the title gives way first). */
function fileBase(item, kind) {
    const title = cleanPart(item && item.title) || (kind === 'clip' ? 'Clip' : 'Stream recording');
    const who = cleanPart(item && (kind === 'clip' ? (item.source_streamer_username || item.username) : (item.display_name || item.username)));
    const day = /^\d{4}-\d{2}-\d{2}/.test(String(item && item.created_at || '')) ? String(item.created_at).slice(0, 10) : '';
    const tail = [who, day].filter(Boolean).join(' - ');
    const room = Math.max(10, FILE_NAME_MAX - (tail ? tail.length + 3 : 0));
    const t = title.length > room ? `${title.slice(0, room - 1).trim()}…` : title;
    return tail ? `${t} - ${tail}` : t;
}

/** Content-Disposition for a download: an ASCII name and the UTF-8 one. */
function disposition(file) {
    const ascii = file.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const utf8 = encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** 75 → "1:15", 3725 → "1:02:05" (hours when `long`, or when there are any). */
function clockLabel(seconds, long = false) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(n / 3600);
    const m = Math.floor((n % 3600) / 60);
    const s = n % 60;
    return h || long ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** SubRip time: 00:01:02,345. */
function srtTime(seconds) {
    const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** The header every text file starts with: what it is, from where, and how to get back to it. */
function textHeader(meta, what) {
    return [meta.title, [meta.channel, meta.date, meta.length].filter(Boolean).join(' · '), meta.url, what, ''].filter((l, i) => l || i === 4).join('\n');
}

// ── Formats ────────────────────────────────────────────────
const transcriptFormats = {
    txt: (meta, segs) => `${textHeader(meta, 'Transcript (AI)')}\n${segs.map((s) => `[${clockLabel(s.start, meta.long)}] ${oneLine(s.text)}`).join('\n')}\n`,
    srt: (_meta, segs) => `${segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${oneLine(s.text)}\n`).join('\n')}`,
    json: (meta, segs) => `${JSON.stringify({ ...meta.ref, title: meta.title, url: meta.url, transcript: segs.map((s) => ({ start: s.start, end: s.end, text: oneLine(s.text) })) }, null, 2)}\n`,
};

/** A CSV cell: quoted when it must be, and a leading = + - @ made inert so a spreadsheet never runs it. */
function csvCell(v) {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const chatFormats = {
    txt: (meta, rows) => `${textHeader(meta, `Chat replay (${rows.length} messages)`)}\n${rows.map((r) => `[${clockLabel(r.offset, meta.long)}] ${r.name || r.username || '?'}: ${oneLine(r.text)}`).join('\n')}\n`,
    csv: (meta, rows) => `${['time', 'seconds', 'sent_at', 'username', 'display_name', 'message'].join(',')}\r\n${rows.map((r) => [clockLabel(r.offset, meta.long), r.offset, r.sentAt || '', r.username || '', r.name || '', oneLine(r.text)].map(csvCell).join(',')).join('\r\n')}\r\n`,
    json: (meta, rows) => `${JSON.stringify({ ...meta.ref, title: meta.title, url: meta.url, messages: rows.map((r) => ({ seconds: r.offset, sent_at: r.sentAt || null, username: r.username || null, display_name: r.name || null, message: r.text })) }, null, 2)}\n`,
};

/**
 * Chapters as a YouTube description takes them: one "m:ss Title" line each, the first at 0:00 (YouTube needs that,
 * so a first chapter later than the start gets a "Start" line before it).
 */
const chapterFormats = {
    txt: (meta, chs) => {
        const lines = chs.map((c) => `${clockLabel(c.offset_seconds, meta.long)} ${oneLine(c.description)}`);
        if (chs.length && chs[0].offset_seconds >= 1) lines.unshift(`${clockLabel(0, meta.long)} Start`);
        return `${lines.join('\n')}\n`;
    },
    json: (meta, chs) => `${JSON.stringify({ ...meta.ref, title: meta.title, url: meta.url, chapters: chs.map((c, i) => ({ start: c.offset_seconds, end: i + 1 < chs.length ? chs[i + 1].offset_seconds : (meta.seconds || null), title: oneLine(c.description) })) }, null, 2)}\n`,
};

/** What the item is, as one JSON file: the page's facts and where each of its files is. */
function infoJson(meta, item, kind, files) {
    const o = {
        ...meta.ref,
        title: meta.title,
        url: meta.url,
        channel: meta.channel || null,
        created_at: item.created_at || null,
        duration_seconds: item.duration_seconds == null ? null : Number(item.duration_seconds),
        description: item.description || null,
        summary: item.ai_overview || null,
        visibility: item.visibility || null,
        views: item.view_count == null ? null : Number(item.view_count),
    };
    if (kind === 'vod') {
        Object.assign(o, {
            category: item.stream_category || null,
            stream: item.stream_id ? { id: Number(item.stream_id), started_at: item.stream_started_at || null, ended_at: item.stream_ended_at || null, part: item.part || null, starts_at_second: item.stream_offset_sec == null ? null : Number(item.stream_offset_sec) } : null,
        });
    } else {
        Object.assign(o, {
            recording: item.vod_id ? { id: Number(item.vod_id), from_second: item.start_time == null ? null : Number(item.start_time), url: meta.recordingUrl || null } : null,
            made_by: item.username || null,
            ai_clip: Boolean(item.auto_generated),
        });
    }
    o.files = files;
    return `${JSON.stringify(o, null, 2)}\n`;
}

// ── Zip ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
})();
function crc32(buf) {
    if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** A .zip of [{ name, data }] (deflated, UTF-8 names, one timestamp). Small text files: built in memory. */
function zip(files, when = new Date()) {
    const dosTime = ((when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate()) & 0xffff;
    const local = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
        const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
        const name = Buffer.from(f.name, 'utf8');
        const packed = zlib.deflateRawSync(data, { level: 9 });
        const stored = packed.length >= data.length;
        const body = stored ? data : packed;
        const crc = crc32(data);
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
        head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12); head.writeUInt32LE(crc, 14);
        head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
        local.push(head, name, body);
        const dir = Buffer.alloc(46);
        dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(stored ? 0 : 8, 10);
        dir.writeUInt16LE(dosTime, 12); dir.writeUInt16LE(dosDate, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24);
        dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
        central.push(dir, name);
        offset += head.length + name.length + body.length;
    }
    const dirBuf = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(dirBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, dirBuf, end]);
}

// ── The menu ───────────────────────────────────────────────
const FORMAT_HELP = {
    mp4: 'The video file', webm: 'The video file', jpg: 'The cover picture', png: 'The cover picture', webp: 'The cover picture',
    txt: 'Plain text, with times', srt: 'Subtitles for video editors and players (SubRip)', vtt: 'Web captions (WebVTT)',
    csv: 'A table for spreadsheets', json: 'Data for programs', zip: 'Everything in one file',
};
const CHAPTER_TXT_HELP = 'Times and titles, ready to paste into a YouTube description';

/** One row of the menu: an icon, what it is (and a line about it), and a link per format. */
function row({ icon, label, about, links }) {
    return html`<li class="ovv-dl-row"><i class="${icon}" aria-hidden="true"></i><span class="ovv-dl-what"><span class="ovv-dl-label">${label}</span>${about ? html`<span class="ovv-dl-about">${about}</span>` : ''}</span><span class="ovv-dl-formats">${links.map((l) => html`<a class="ovv-dl-format${l.main ? ' ovv-dl-format--main' : ''}" href="${l.href}" download rel="nofollow" title="${l.help || FORMAT_HELP[l.ext] || ''}" aria-label="${label}: ${l.text || l.ext.toUpperCase()} (${l.help || FORMAT_HELP[l.ext] || ''})">${l.text || l.ext.toUpperCase()}</a>`)}</span></li>`;
}

/** "570.7 MB" for a byte count (null when unknown). */
function sizeLabel(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return null;
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let v = n; let u = 0;
    while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
    return `${u ? v.toFixed(v < 10 ? 1 : 0) : v} ${units[u]}`;
}

/** The file extension a video download will have (Media adds the real one; MP4 unless the file says otherwise). */
function videoExt(item) {
    const p = String((item && (item.file_path || item.file_url)) || '');
    return /\.webm(\?|$)/i.test(p) ? 'webm' : 'mp4';
}

/**
 * The Download button and its menu: what this item has, each in its formats. `has` = { transcript: n, chat: n,
 * chapters: n } (counts; 0 = left out). A <details> menu: it opens and closes without JavaScript; video.js only closes
 * it on a click elsewhere or Escape and keeps it on screen.
 */
function downloadMenu({ kind, id, item, has }) {
    const at = `/${kind === 'clip' ? 'c' : 'v'}/${id}/download`;
    const ready = !item.is_recording && (kind === 'vod' || !item.status || item.status === 'ready');
    const rows = [];
    if (ready) {
        const size = sizeLabel(item.file_size);
        const ext = videoExt(item);
        rows.push(row({ icon: 'fa-solid fa-film', label: 'Video', about: [kind === 'clip' ? 'The clip' : 'The whole recording', size].filter(Boolean).join(' · '), links: [{ href: `${at}/video`, ext, main: true }] }));
    }
    if (has.transcript) rows.push(row({ icon: 'fa-solid fa-closed-captioning', label: 'Transcript', about: `${has.transcript} lines, by AI`, links: ['txt', 'srt', 'vtt', 'json'].map((ext) => ({ href: `${at}/transcript.${ext}`, ext })) }));
    if (has.chat) rows.push(row({ icon: 'fa-solid fa-comments', label: 'Chat replay', about: `${has.chat} messages`, links: ['txt', 'csv', 'json'].map((ext) => ({ href: `${at}/chat.${ext}`, ext })) }));
    if (has.chapters) rows.push(row({ icon: 'fa-solid fa-list-ol', label: 'Chapters', about: `${has.chapters} chapters`, links: [{ href: `${at}/chapters.txt`, ext: 'txt', help: CHAPTER_TXT_HELP }, { href: `${at}/chapters.vtt`, ext: 'vtt' }, { href: `${at}/chapters.json`, ext: 'json' }] }));
    if (item.thumbnail_url) rows.push(row({ icon: 'fa-regular fa-image', label: 'Cover picture', about: null, links: [{ href: `${at}/thumbnail`, ext: 'jpg', text: 'Image' }] }));
    rows.push(row({ icon: 'fa-solid fa-circle-info', label: 'Details', about: 'Title, channel, dates, summary', links: [{ href: `${at}/info.json`, ext: 'json' }] }));
    const everything = html`<li class="ovv-dl-row ovv-dl-row--all"><i class="fa-solid fa-file-zipper" aria-hidden="true"></i><span class="ovv-dl-what"><span class="ovv-dl-label">Everything</span><span class="ovv-dl-about">All of the above but the video, in one .zip</span></span><span class="ovv-dl-formats"><a class="ovv-dl-format ovv-dl-format--main" href="${at}/all.zip" download rel="nofollow" title="${FORMAT_HELP.zip}" aria-label="Everything: ZIP (${FORMAT_HELP.zip})">ZIP</a></span></li>`;
    return html`<details class="ovv-dl" data-ovv-dl><summary class="ovv-btn"><i class="fa-solid fa-download" aria-hidden="true"></i> Download</summary>
<div class="ovv-dl-menu" role="group" aria-label="Download this ${kind === 'clip' ? 'clip' : 'recording'}">
<div class="ovv-dl-head"><span>Download this ${kind === 'clip' ? 'clip' : 'recording'}</span><button type="button" class="ovv-dl-close" data-ovv-dl-close aria-label="Close"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></div>
<ul class="ovv-dl-list">${rows}${everything}</ul>
<p class="ovv-dl-hint">Hover or long-press a format to see what it is for.</p>
</div></details>`;
}

// ── Routes ─────────────────────────────────────────────────
const TYPES = {
    txt: 'text/plain; charset=utf-8', srt: 'application/x-subrip; charset=utf-8', vtt: 'text/vtt; charset=utf-8',
    json: 'application/json; charset=utf-8', csv: 'text/csv; charset=utf-8', zip: 'application/zip',
};
const VOD_FILES = new Set(['video', 'thumbnail', 'info.json', 'all.zip',
    'transcript.txt', 'transcript.srt', 'transcript.vtt', 'transcript.json', 'chat.txt', 'chat.csv', 'chat.json',
    'chapters.txt', 'chapters.vtt', 'chapters.json']);
const CLIP_FILES = new Set(['video', 'thumbnail', 'info.json', 'all.zip', 'transcript.txt', 'transcript.srt', 'transcript.vtt', 'transcript.json']);

/**
 * Mount /v/:id/download/:file and /c/:id/download/:file. `deps` are the watch pages' own readers, so a file holds
 * exactly what the page shows.
 */
function mountDownloads(r, deps) {
    const { live, chat, ownView, asPerson, notFound, base, httpsUrl, fetchImpl, log,
        transcriptSegments, moments, chapters, chatMessageRows, renderCaptionsVtt, renderChaptersVtt } = deps;

    /** The item as the page shows it to this reader (public, or their own private one) → { item, own } or null. */
    async function load(req, res, kind, id) {
        let data = kind === 'vod' ? await live.vod(id) : await live.clip(id);
        let own = false;
        if (!data || !(kind === 'vod' ? data.vod : data.clip)) {
            data = await ownView(req, res, kind, id);
            own = true;
        }
        const item = data && (kind === 'vod' ? data.vod : data.clip);
        return item ? { item, own } : null;
    }

    function metaOf(kind, id, item) {
        const seconds = Number(item.duration_seconds) || 0;
        return {
            ref: { [kind === 'clip' ? 'clip_id' : 'recording_id']: Number(id) },
            title: item.title || (kind === 'clip' ? 'Clip' : 'Stream recording'),
            channel: kind === 'clip' ? (item.source_streamer_display_name || item.source_streamer_username || null) : (item.display_name || item.username || null),
            date: /^\d{4}-\d{2}-\d{2}/.test(String(item.created_at || '')) ? String(item.created_at).slice(0, 10) : null,
            length: seconds ? clockLabel(seconds) : null,
            seconds: seconds || null,
            long: seconds >= 3600,
            url: `${base}/${kind === 'clip' ? 'c' : 'v'}/${id}`,
            recordingUrl: kind === 'clip' && item.vod_id ? `${base}/v/${item.vod_id}` : null,
        };
    }

    /** The memories as chapters (as the reader: a private recording's are only Live's answer to its owner). */
    async function chapterList(req, res, id, item, own) {
        try {
            const m = own ? await asPerson(req, res, (token) => live.vodMemoriesAs(token, id)) : await live.vodMemories(id);
            return chapters(moments(m && m.memories), item.duration_seconds);
        } catch { return []; }
    }
    async function chatRows(item) {
        try {
            const replay = await chat.chatReplay(item.stream_id);
            const out = chatMessageRows(item, replay && Array.isArray(replay.messages) ? replay.messages : [], Infinity);
            return out ? out.rows : [];
        } catch { return []; }
    }

    function sendText(res, own, file, ext, body) {
        res.set({
            'Content-Type': TYPES[ext], 'Content-Disposition': disposition(file), 'X-Robots-Tag': 'noindex',
            'Cache-Control': own ? 'private, no-store' : 'public, max-age=300', 'X-Content-Type-Options': 'nosniff',
        });
        return res.send(body);
    }
    const missing = (res) => res.status(404).set({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' }).send('Not found');

    /** The cover picture's bytes (Media's thumbnail), or null. Only an https URL from Live is fetched. */
    async function thumbnail(item) {
        const url = httpsUrl(item.thumbnail_url);
        if (!url) return null;
        try {
            const up = await fetchImpl(url, { headers: { Accept: 'image/*' }, credentials: 'omit', signal: AbortSignal.timeout(FETCH_MS) });
            if (!up.ok) return null;
            const type = String(up.headers.get('content-type') || '').split(';')[0].trim();
            if (!/^image\/(jpeg|png|webp)$/.test(type)) return null;
            const body = Buffer.from(await up.arrayBuffer());
            if (!body.length || body.length > THUMB_MAX_BYTES) return null;
            return { body, type, ext: type === 'image/jpeg' ? 'jpg' : type.slice(6) };
        } catch { return null; }
    }

    /** Every text file of the item: [{ name, data }] (what "Everything" zips). */
    async function textFiles(req, res, kind, id, item, own, meta, base_) {
        const files = [];
        const segs = transcriptSegments(item);
        if (segs.length) {
            files.push({ name: `${base_}.transcript.txt`, data: transcriptFormats.txt(meta, segs) },
                { name: `${base_}.transcript.srt`, data: transcriptFormats.srt(meta, segs) },
                { name: `${base_}.transcript.vtt`, data: renderCaptionsVtt(segs) },
                { name: `${base_}.transcript.json`, data: transcriptFormats.json(meta, segs) });
        }
        if (kind === 'vod') {
            const [rows, chs] = await Promise.all([chatRows(item), chapterList(req, res, id, item, own)]);
            if (rows.length) {
                files.push({ name: `${base_}.chat.txt`, data: chatFormats.txt(meta, rows) },
                    { name: `${base_}.chat.csv`, data: chatFormats.csv(meta, rows) },
                    { name: `${base_}.chat.json`, data: chatFormats.json(meta, rows) });
            }
            if (chs.length) {
                files.push({ name: `${base_}.chapters.txt`, data: chapterFormats.txt(meta, chs) },
                    { name: `${base_}.chapters.vtt`, data: renderChaptersVtt(chs, item.duration_seconds) },
                    { name: `${base_}.chapters.json`, data: chapterFormats.json(meta, chs) });
            }
        }
        return files;
    }

    function route(kind) {
        const allowed = kind === 'vod' ? VOD_FILES : CLIP_FILES;
        return async (req, res) => {
            const id = String(req.params.id || '');
            const file = String(req.params.file || '');
            if (!live.isId(id) || !allowed.has(file)) return notFound(req, res);
            const found = await load(req, res, kind, id);
            if (!found) return notFound(req, res);
            const { item, own } = found;
            const meta = metaOf(kind, id, item);
            const name = fileBase(item, kind);

            if (file === 'video') {
                // OpenVibe.Media's file as an attachment: Live hands out its URL (a signed one for an owner's private item).
                try {
                    const got = own
                        ? await asPerson(req, res, (token) => live.downloadUrlAs(token, kind, id, name))
                        : await live.downloadUrl(kind, id, name);
                    const url = got && httpsUrl(got.url);
                    if (!url) return notFound(req, res);
                    res.set({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' });
                    return res.redirect(302, url);
                } catch (err) {
                    log.warn('[OpenVibe.Video] download link failed', err && err.message);
                    return res.status(502).set('Content-Type', 'text/plain; charset=utf-8').send('OpenVibe.Live did not give a download link; try again in a minute.');
                }
            }
            if (file === 'thumbnail') {
                const t = await thumbnail(item);
                if (!t) return missing(res);
                res.set({ 'Content-Type': t.type, 'Content-Disposition': disposition(`${name}.${t.ext}`), 'X-Robots-Tag': 'noindex', 'Cache-Control': own ? 'private, no-store' : 'public, max-age=3600' });
                return res.send(t.body);
            }

            const [what, ext] = file.split('.');
            if (what === 'transcript') {
                const segs = transcriptSegments(item);
                if (!segs.length) return missing(res);
                const body = ext === 'vtt' ? renderCaptionsVtt(segs) : transcriptFormats[ext](meta, segs);
                return sendText(res, own, `${name}.transcript.${ext}`, ext, body);
            }
            if (what === 'chat') {
                const rows = await chatRows(item);
                if (!rows.length) return missing(res);
                return sendText(res, own, `${name}.chat.${ext}`, ext, chatFormats[ext](meta, rows));
            }
            if (what === 'chapters') {
                const chs = await chapterList(req, res, id, item, own);
                if (!chs.length) return missing(res);
                const body = ext === 'vtt' ? renderChaptersVtt(chs, item.duration_seconds) : chapterFormats[ext](meta, chs);
                return sendText(res, own, `${name}.chapters.${ext}`, ext, body);
            }
            const texts = await textFiles(req, res, kind, id, item, own, meta, name);
            const listing = Object.fromEntries(texts.map((f) => [f.name.slice(name.length + 1), f.name]));
            const info = infoJson(meta, item, kind, { video: `${meta.url}/download/video`, ...listing });
            if (file === 'info.json') return sendText(res, own, `${name}.info.json`, 'json', info);
            // all.zip: a folder named after the item, every text file, the details and the cover picture.
            const t = await thumbnail(item);
            const inZip = [{ name: `${name}/${name}.info.json`, data: info }, ...texts.map((f) => ({ name: `${name}/${f.name}`, data: f.data }))];
            if (t) inZip.push({ name: `${name}/${name}.${t.ext}`, data: t.body });
            return sendText(res, own, `${name}.zip`, 'zip', zip(inZip));
        };
    }

    r.get('/v/:id/download/:file', route('vod'));
    r.get('/c/:id/download/:file', route('clip'));
}

module.exports = {
    mountDownloads, downloadMenu, fileBase, disposition, clockLabel, srtTime, csvCell, zip, crc32, sizeLabel,
    transcriptFormats, chatFormats, chapterFormats, infoJson, CHAPTER_TXT_HELP,
};
