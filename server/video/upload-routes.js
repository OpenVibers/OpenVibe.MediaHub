'use strict';

/**
 * Uploads on openvibe.video (server/video/uploads.js): the pages and the part API.
 *
 *   GET  /upload                     the form (title, description, visibility, the file); public/js/video-upload.js sends it
 *   POST /api/v1/videos              start: { title, description, visibility, size, content_type, name } → { upload }
 *   PUT  /api/v1/videos/:id/parts/:n one 8 MB part, in order (application/octet-stream)
 *   POST /api/v1/videos/:id/complete close the file; Media finishes it in the background → { video: { id, url } }
 *   GET  /u/:id                      the watch page (processing: it says so and reloads itself)
 *   POST /u/:id/manage | /u/:id/delete | /u/:id/report
 *   POST /u/:id/cut                  the owner queues an AI cut (server/video/cut.js): pauses, tight or highlights
 *   POST /api/v1/videos/:id/cuts     the same as JSON { mode } → 202 { cut };  GET …/cuts → { cuts }
 *   GET  /me/videos                  your uploads, with their state
 *   GET  /record                     record from the camera or the screen in the browser (public/js/video-record.js)
 *   POST /api/v1/videos/recordings   start: { title, description, visibility, content_type } → { upload }
 *   PUT  /api/v1/videos/:id/chunks/:n  the recording's next piece (up to 9 MB), in order, while it records
 *
 * Every write is a signed-in person's (a session on openvibe.video) from openvibe.video itself (Sec-Fetch-Site or
 * Origin). Reports are open to anyone who can see the video, one per person (or per keyed address) per video.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const cache = require('openvibe-shared/cache-policy');
const { sameOrigin } = require('../http/principal');
const { html, raw, notice, askAgent } = require('../render/html');
const { companion, deleteAction } = require('./watch-ui');

/** An AI overview that is the analyser's own measurements (no model wrote it: "Length analysed: 2:13. Streams: …"),
 *  never shown as the video's summary (the owner's phone, 11-18). ai-edit.js asks for a model's summary again. */
const isFactsOverview = (t) => /^Length analysed:/.test(String(t || '').trim());

/** A chapter's name as a list says it: its first sentence, at most seven words (the AI names a chapter by the words said
 *  there, which ran to a whole verse: "Got some ashwagandha. Got me some magnesium. Got me some daba. Got me"). */
function chapterName(title, i) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (!t || /^(highlight|start)$/i.test(t)) return i === 0 ? 'Start' : 'Highlight';
    const first = ((t.match(/^.*?[.!?](?=\s|$)/) || [t])[0]).replace(/[.!?]+$/, '').trim() || t;
    const words = first.split(' ');
    return words.length > 7 ? `${words.slice(0, 7).join(' ')}…` : first;
}
/** The AI's chapters → the rows the chapter list draws ({ offset_seconds, description }); a repeated name is numbered. */
function chapterRows(list) {
    const seen = new Map();
    return (Array.isArray(list) ? list : []).filter((c) => c && Number.isFinite(Number(c.start))).map((c, i) => {
        let name = chapterName(c.title, i);
        const n = (seen.get(name) || 0) + 1;
        seen.set(name, n);
        if (n > 1) name = `${name} (${n})`;
        return { offset_seconds: Math.max(0, Math.floor(Number(c.start))), description: name };
    });
}
/**
 * The transcript as lines a person reads (11-18: one 133-second segment showed as "1 lines"): a long segment is split at
 * its sentences, short ones joined to about a line, each line timed in proportion to where its words fall.
 */
function transcriptLines(segments) {
    const out = [];
    for (const g of Array.isArray(segments) ? segments : []) {
        const text = String((g && g.text) || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const start = Math.max(0, Number(g.start) || 0);
        const end = Number(g.end) > start ? Number(g.end) : start;
        const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
        if (parts.length < 2 || end - start < 8) { out.push({ start, text }); continue; }
        let at = 0, buf = '', from = 0;
        for (const part of parts) {
            if (!buf) from = at;
            buf = buf ? `${buf} ${part.trim()}` : part.trim();
            at += part.length;
            if (buf.length >= 44) { out.push({ start: start + (end - start) * (from / text.length), text: buf }); buf = ''; }
        }
        if (buf) out.push({ start: start + (end - start) * (from / text.length), text: buf });
    }
    return out.slice(0, 5000);
}
const RELATED_STOP = new Set(['this', 'that', 'with', 'from', 'your', 'have', 'what', 'when', 'into', 'about', 'video', 'videos', 'just', 'like', 'more', 'some']);
const { UploadError } = require('./uploads');
const { ShareError } = require('openvibe-sdk/share');
const { createCommentsClient, CommentError } = require('./comments-client');
const { renderThread } = require('openvibe-shared/thread');
const { multipart: commentMultipart, readCommentForm } = require('../comments/form');

const REASON_TEXT = {
    child_safety: 'It sexualises or endangers a child', violence: 'Violence or a threat', harassment: 'Harassment or someone\'s private details',
    sexual: 'Sexual content', copyright: 'It is my work, used without permission', spam: 'Spam or a scam', other: 'Something else',
};

function problem(res, err) {
    const e = err instanceof UploadError || err instanceof ShareError ? err : null;
    if (!e) throw err;
    return res.status(e.status).type('application/problem+json').json({ type: 'about:blank', status: e.status, code: e.code, detail: e.detail });
}

/** The JSON part API (mounted before the site's urlencoded parser: parts are raw bytes). */
function createUploadApi({ ctx, config }) {
    const up = ctx.videoUploads;
    const studioUrl = String((config.video && config.video.studioUrl) || 'https://openvibe.studio').replace(/\/+$/, '');
    const studioEditUrl = (row) => (config.video && config.video.studioVideoEdit
        ? `${studioUrl}/edit?media=${encodeURIComponent(row.id)}&from=video` : null);
    const r = express.Router();
    r.use((req, res, next) => { res.set('Cache-Control', cache.htmlHeaders({ private: true })); next(); });
    const who = (req) => (req.viewer && req.viewer.kind === 'user' && req.viewer.subject
        ? { requester: `user:${req.viewer.subject}`, username: req.viewer.username || null } : null);
    const guard = (req, res) => {
        if (!who(req)) { problem(res, new UploadError(401, 'auth.required', 'Sign in to upload a video.')); return false; }
        if (!sameOrigin(req, config.video.url)) { problem(res, new UploadError(403, 'upload.cross_site', 'Upload from openvibe.video itself.')); return false; }
        return true;
    };
    const own = async (req, res) => {
        const row = await up.byId(req.params.id);
        if (!row || row.owner !== who(req).requester || row.state === 'removed') { problem(res, new UploadError(404, 'upload.not_found', 'No such upload.')); return null; }
        return row;
    };

    r.post('/', express.json({ limit: '16kb' }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        try {
            const b = req.body || {};
            const row = await up.start(who(req), { title: b.title, description: b.description, visibility: b.visibility, audience: b.audience, size: b.size, contentType: b.content_type, name: b.name });
            return res.status(201).json({ upload: { id: row.id, part_size: row.part_size, parts_expected: row.parts_expected } });
        } catch (err) { return problem(res, err); }
    });

    r.get('/:id/status', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        return res.json({ upload: { id: row.id, status: row.status, part_size: row.part_size, parts_expected: row.parts_expected, parts_received: row.parts_received, size: Number(row.size_bytes), title: row.title, description: row.description, visibility: row.visibility } });
    });

    r.patch('/:id', express.json({ limit: '16kb' }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const b = req.body || {};
            const updated = await up.update(row, { title: b.title, description: b.description, visibility: b.visibility, audience: b.audience });
            return res.json({ upload: { id: updated.id, title: updated.title, visibility: updated.visibility } });
        } catch (err) { return problem(res, err); }
    });

    r.delete('/:id', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        await up.remove(row);
        return res.status(204).end();
    });

    r.put('/:id/parts/:n', express.raw({ type: () => true, limit: `${Math.ceil(up.PART_SIZE / 1024) + 64}kb` }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const out = await up.part(row, Number(req.params.n), Buffer.isBuffer(req.body) ? req.body : null);
            return res.json({ parts_received: out.parts_received, parts_expected: out.parts_expected });
        } catch (err) { return problem(res, err); }
    });

    r.post('/recordings', express.json({ limit: '16kb' }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        try {
            const b = req.body || {};
            const row = await up.startRecording(who(req), { title: b.title, description: b.description, visibility: b.visibility, audience: b.audience, contentType: b.content_type });
            return res.status(201).json({ upload: { id: row.id } });
        } catch (err) { return problem(res, err); }
    });

    r.put('/:id/chunks/:n', express.raw({ type: () => true, limit: '9mb' }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const out = await up.chunk(row, Number(req.params.n), Buffer.isBuffer(req.body) ? req.body : null);
            return res.json({ pieces: out.parts_received, size_bytes: Number(out.size_bytes) });
        } catch (err) { return problem(res, err); }
    });

    r.post('/:id/complete', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const out = await up.complete(row);
            const editUrl = studioEditUrl(out);
            return res.status(202).json({ video: { id: out.id, status: out.status, url: out.watch_id ? `/watch?v=${out.watch_id}` : `/u/${out.id}`, ...(editUrl ? { edit_url: editUrl } : {}) } });
        } catch (err) { return problem(res, err); }
    });

    // The AI cut (server/video/cut.js): queue an edited copy, and read how the cuts of an upload are going.
    const cutWire = (c) => ({
        id: c.id, mode: c.mode, status: c.status, progress: Number(c.progress) || 0, error: c.error || null,
        source_seconds: c.source_seconds == null ? null : Number(c.source_seconds), kept_seconds: c.kept_seconds == null ? null : Number(c.kept_seconds),
        removed_count: c.removed_count == null ? null : Number(c.removed_count),
        result: c.result_upload_id && c.status === 'done' ? { id: c.result_upload_id, url: c.result_watch_id ? `/watch?v=${c.result_watch_id}` : `/u/${c.result_upload_id}` } : null,
        created_at: c.created_at, finished_at: c.finished_at || null,
    });
    r.post('/:id/cuts', express.json({ limit: '4kb' }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const cut = await ctx.videoCuts.request(row, who(req), String((req.body || {}).mode || 'pauses'));
            return res.status(202).json({ cut: cutWire(cut) });
        } catch (err) { return problem(res, err); }
    });
    r.get('/:id/cuts', async (req, res) => {
        if (!who(req)) return problem(res, new UploadError(401, 'auth.required', 'Sign in first.'));
        const row = await own(req, res);
        if (!row) return undefined;
        return res.json({ cuts: (await ctx.videoCuts.forUpload(row)).map(cutWire) });
    });

    return r;
}

/** The pages; `h` carries the video site's helpers (page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, cards). */
function mountUploadPages(r, h) {
    const { ctx, page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, visibilityOptions, visibilityLabel, durationLabel, dateLabel, httpsUrl, fileOf, hlsAttrs, grid, card, renderCaptionsVtt, renderChaptersVtt, vttTime, sendVtt, notFoundVtt, playlistForm, upNext, whatItIs, shareButton, renderVod, renderClip,
        titleLine, watchFacts, watchAbout, watchMore, visibilityChoices, visibilityBadge, editButton, partyLink, likeButton, likesOf } = h;
    const up = ctx.videoUploads;
    const comments = createCommentsClient({ config: ctx.config, fetchImpl: ctx.fetchImpl || globalThis.fetch });
    const commentLimit = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false });
    const commentSort = (req) => req.query.sort === 'new' ? 'new' : 'top';
    const commentAfter = (req) => typeof req.query.after === 'string' && /^(?:-?\d{1,12}:)?\d{1,15}$/.test(req.query.after) ? req.query.after : null;
    const cfg = ctx.config.videoUploads;
    const whoOf = (req) => ({ requester: signedIn(req) ? ownerOf(req) : null, staff: isStaff(req) });
    const GB = 1024 ** 3;
    const VIS = ['public', 'unlisted', 'private'];
    const audienceOptions = (current) => [['public', 'Everyone'], ['link', 'Anyone with the link'], ['people', 'Specific people'], ['private', 'Only me']]
        .map(([value, label]) => html`<option value="${value}"${value === current ? raw(' selected') : ''}>${label}</option>`);

    const statusText = (row) => (row.state === 'hidden' ? 'Hidden after reports, waiting for staff'
        : row.status === 'uploading' ? `Upload stopped at ${Math.round((row.parts_received / row.parts_expected) * 100)}%`
            : row.status === 'processing' ? 'Processing' : row.status === 'failed' ? 'Failed' : visibilityLabel(row.visibility));

    // Your videos: one card per upload with the same words the watch page uses, its picture when Media has made one,
    // and the shared progress meter when the upload stopped part-way (Resume opens /upload, which reads IndexedDB).
    const uploadState = (row) => (row.state === 'hidden' ? 'hidden'
        : row.status === 'uploading' ? 'uploading' : row.status === 'processing' ? 'processing' : row.status === 'failed' ? 'failed' : 'ready');
    /** Where "Edit in Studio" goes (the hand-off; see server/video/studio.js). */
    const studioUrl = String((ctx.config.video && ctx.config.video.studioUrl) || 'https://openvibe.studio').replace(/\/+$/, '');
    const studioVideoEdit = Boolean(ctx.config.video && ctx.config.video.studioVideoEdit);
    const studioEditUrl = (row) => (studioVideoEdit ? `${studioUrl}/edit?media=${encodeURIComponent(row.id)}&from=video` : null);

    function myVideoRow(row) {
        const state = uploadState(row);
        const watch = row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`;
        const views = Number(row.views) || 0;
        const pct = row.parts_expected ? Math.round((Number(row.parts_received) / Number(row.parts_expected)) * 100) : 0;
        const meta = [visibilityLabel(row.visibility), row.duration_seconds ? durationLabel(row.duration_seconds) : null,
            `${views} view${views === 1 ? '' : 's'}`, dateLabel(row.created_at)].filter(Boolean).join(' · ');
        const done = Number(row.parts_received) * Number(row.part_size);
        const total = Number(row.size_bytes);
        return html`<li class="ovv-myrow" data-state="${state}">
<a class="ovv-mythumb" href="${watch}" tabindex="-1" aria-hidden="true">${row.thumbnail_url ? html`<img src="${row.thumbnail_url}" alt="" loading="lazy">` : html`<i class="ovg-fill" data-ov-icon="film"></i>`}</a>
<div class="ovv-mybody">
<div class="ovv-mytitleline"><a class="ovv-mytitle" href="${watch}">${row.title}</a><span class="ovv-mystate">${statusText(row)}</span></div>
<p class="ovv-mymeta">${meta}</p>
${state === 'uploading' ? html`<div class="ovv-myprogress" data-ov-upload-progress data-state="waiting" data-done="${done}" data-total="${total}">Upload stopped at ${pct}%</div>` : ''}
${state === 'processing' ? html`<p class="ovv-myprocess"><span class="ovv-pulse" aria-hidden="true"></span> Making it playable. You can close this page.</p>` : ''}
<div class="ovv-myactions">
${state === 'uploading' ? html`<a class="ovv-btn ovv-btn--small ovv-btn--primary" href="/upload">Resume upload</a>` : ''}
${state === 'ready' ? html`<a class="ovv-btn ovv-btn--small" href="${watch}">Watch</a> <a class="ovv-btn ovv-btn--small" href="${watch}#h-owner">Edit</a>${studioVideoEdit ? html` <a class="ovv-btn ovv-btn--small" href="${studioEditUrl(row)}">Edit in Studio</a>` : ''}` : ''}
${state === 'processing' || state === 'hidden' || state === 'failed' ? html`<a class="ovv-btn ovv-btn--small" href="${watch}">Open</a>` : ''}
<button class="ovv-btn ovv-btn--small ovv-btn--danger" type="button" data-delete-video="${row.id}" data-delete-title="${row.title}">Delete</button>
</div>
</div></li>`;
    }

    const CUT_STATUS = { queued: 'Waiting to start', measuring: 'Finding the pauses', rendering: 'Making the copy' };
    const CUT_LABEL = { pauses: 'Pauses cut', tight: 'Tight cut', highlights: 'Highlights reel', trim: 'Trimmed' };
    function cutLine(c) {
        const what = html`<b>${CUT_LABEL[c.mode] || c.mode}</b>`;
        if (c.status === 'done') {
            const shorter = c.source_seconds && c.kept_seconds ? html` · ${durationLabel(c.source_seconds)} cut to ${durationLabel(c.kept_seconds)}` : '';
            const count = c.removed_count ? html` · ${c.removed_count} pause${c.removed_count === 1 ? '' : 's'} out` : '';
            return html`<li>${what}${shorter}${count} · ${c.result_upload_id ? html`<a href="${c.result_watch_id ? `/watch?v=${c.result_watch_id}` : `/u/${c.result_upload_id}`}">open the copy</a>` : 'done'}</li>`;
        }
        if (c.status === 'failed') return html`<li>${what} · not made: ${c.error || 'something went wrong'}</li>`;
        const pct = c.status === 'rendering' ? html` ${Math.round(Number(c.progress || 0) * 100)}%` : '';
        return html`<li>${what} · <span role="status">${CUT_STATUS[c.status]}${pct}…</span></li>`;
    }
    function cutPanel(row, cuts, busy, reel) {
        const m = ctx.videoCuts.MODES;
        return html`<section class="ovv-panel ovv-cut" aria-labelledby="h-cut"><h2 id="h-cut">AI edit</h2>
<p class="ovv-fine">Make an edited copy. The original stays as it is; the copy is private until you publish it and gets its own captions and chapters.</p>
<form method="post" action="/u/${row.id}/cut">
<fieldset class="ovv-cut-modes"><legend>Make</legend>
<label class="ovv-radio"><input type="radio" name="mode" value="pauses" checked> Cut the pauses <span class="ovv-fine">pauses over ${m.pauses.minPause} s become half a second</span></label>
<label class="ovv-radio"><input type="radio" name="mode" value="tight"> Cut tight <span class="ovv-fine">pauses over ${m.tight.minPause} s become ${m.tight.keep * 2} s</span></label>
${reel ? html`<label class="ovv-radio"><input type="radio" name="mode" value="highlights"> Highlights reel <span class="ovv-fine">${reel.ranges.length} moments the AI picked, ${durationLabel(reel.kept_seconds)}</span></label>` : ''}
</fieldset>
<button class="ovv-btn" type="submit"${busy ? ' disabled' : ''}>Make the edited copy</button>${busy ? html` <span class="ovv-fine">One cut at a time.</span>` : ''}</form>
${cuts.length ? html`<ul class="ovv-cuts">${cuts.map(cutLine)}</ul>` : ''}
</section>`;
    }

    r.get('/upload', mustSignIn('/upload', 'Uploads belong to your OpenVibe account: sign in to upload a video.'), async (req, res) => page(req, res, {
        title: 'Upload a video',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Upload' }],
        styles: ['ov-upload.css'],
        sharedScripts: ['ov-upload.js'],
        scripts: ['js/video-upload.js'],
        body: html`<h1>Upload a video</h1>
<form class="ovv-upload ovv-panel" data-video-upload method="post" action="/upload">
<div class="ovv-upload-pick"><div data-ov-upload-picker data-ov-guide="video.upload"></div>
<ov-progress data-ov-upload-progress hidden></ov-progress></div>
<div class="ovv-upload-details">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="4" maxlength="5000"></textarea></label>
<label class="ovv-field"><span>Who can see it?</span><select name="audience">${audienceOptions(await ctx.sharing.defaultAudience(ownerOf(req), 'video'))}</select></label>
<p class="ovv-fine">For Specific people, name viewers on the video's Share sheet after upload.</p>
<p class="ovv-fine">Upload only what you may share. <button type="button" class="ovv-link-button" data-upload-rules>Rules and limits</button></p>
<p class="ovv-upload-status" role="status" aria-live="polite"></p>
<button class="ovv-btn ovv-btn--primary" type="submit" disabled>Save details</button>
</div>
<noscript><p class="ovv-fine">Uploading needs JavaScript: a video goes up in parts so a big file and a dropped connection both work.</p></noscript>
</form>
<dialog class="ovv-rules" data-upload-rules-sheet aria-label="Upload rules"><h2>Before you upload</h2><p>MP4, MOV, WebM or MKV, up to ${Math.round(cfg.maxBytes / GB)} GB each and ${Math.round(cfg.quotaBytes / GB)} GB total. You may upload ${cfg.perDay} videos a day. Upload only what you made or have permission to share. Reported videos are hidden while staff review them.</p><form method="dialog"><button class="ovv-btn ovv-btn--primary">Got it</button></form></dialog>
<p><a href="/record">Record from your camera or screen instead</a> · <a href="/me/videos">Your videos</a></p>`,
    }));

    r.get('/record', mustSignIn('/record', 'Recordings belong to your OpenVibe account: sign in to record a video.'), async (req, res) => page(req, res, {
        title: 'Record a video',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Record' }],
        scripts: ['js/video-upload.js', 'js/video-record.js'],
        body: html`<h1>Record a video</h1>
<p class="ovv-lede">Open the camera here, then review and trim your clip before saving it to Video.</p>
<form class="ovv-record ovv-panel" data-video-upload data-video-record>
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" placeholder="Untitled recording"></label>
<label class="ovv-field"><span>Who can see it</span><select name="audience">${audienceOptions(await ctx.sharing.defaultAudience(ownerOf(req), 'video'))}</select></label>
<input name="file" type="file" accept="video/webm,video/mp4" class="ovv-record-file" aria-label="Recorded file" tabindex="-1" required>
<textarea name="description" hidden></textarea>
<progress hidden value="0" max="1"></progress>
<p class="ovv-upload-status" role="status" aria-live="polite"></p>
<p class="ovv-record-actions"><button class="ovv-btn ovv-btn--primary" type="button" data-record-open="video">Open camera</button> <button class="ovv-btn" type="button" data-record-open="screen">Record screen</button></p>
<button type="submit" hidden>Save recording</button>
<p class="ovv-fine">Cam records on this page. You can retake or trim before Use this; only then does the file upload. Keep this tab open while it uploads. Up to ${Math.round(cfg.maxBytes / GB)} GB a video.</p>
</form>
<p><a href="/upload">Upload a file instead</a> · <a href="/me/videos">Your videos</a></p>`,
    }));

    // Without JavaScript the form posts here: a video goes up in parts, which needs the page's script.
    r.post('/upload', (req, res) => page(req, res, {
        title: 'Upload a video',
        body: html`<h1>Uploading needs JavaScript</h1><p>A video goes up in 8 MB parts, so a big file and a dropped connection both work. Turn JavaScript on for openvibe.video and <a href="/upload">try again</a>.</p>`,
    }, 400));

    r.get('/me/videos', mustSignIn('/me/videos', 'Sign in to see the videos you uploaded.'), async (req, res) => {
        // A record-only recording arrives without its owner's channel name: it is filled in the first time they look.
        if (req.viewer && req.viewer.username) await up.fillUsername(ownerOf(req), req.viewer.username).catch(() => 0);
        const rows = await up.mine(ownerOf(req));
        await Promise.all(rows.filter((x) => x.status === 'processing').map((x) => up.refresh(x).catch(() => null)));
        const fresh = await up.mine(ownerOf(req));
        const defaultAudience = await ctx.sharing.defaultAudience(ownerOf(req), 'video');
        return page(req, res, {
            title: 'Your videos',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your videos' }],
            styles: ['ov-upload.css'],
            sharedScripts: ['ov-upload.js'],
            scripts: ['js/my-videos.js'],
            body: html`<h1>Your videos</h1>
<div class="ovv-my-head"><p class="ovv-lede">${fresh.length
        ? `${fresh.length} video${fresh.length === 1 ? '' : 's'}, newest first. A processing video finishes in the background, so you can close the page.`
        : 'Everything you upload to OpenVibe.Video appears here, with its state and who can see it.'}</p>
<a class="ovv-btn ovv-btn--primary" href="/upload"><i class="ovg-fill" data-ov-icon="upload" aria-hidden="true"></i> Upload a video</a></div>
<form class="ovv-panel" method="post" action="/me/videos/share-default"><label>New videos <select name="audience">${audienceOptions(defaultAudience)}</select></label> <label><input type="checkbox" name="apply" value="1"> Apply to all my existing videos</label> <button class="ovv-btn" type="submit">Save default</button></form>
${fresh.length ? html`<ul class="ovv-mylist">${fresh.map(myVideoRow)}</ul>` : html`<div class="ovv-my-empty"><i class="ovg-fill" data-ov-icon="film" aria-hidden="true"></i><h2>No videos yet</h2><p>Choose a video and the upload starts while you fill in the title.</p><a class="ovv-btn ovv-btn--primary" href="/upload">Upload your first video</a></div>`}
<dialog class="ovv-rules" data-delete-sheet aria-label="Delete this video">
<h2>Delete this video?</h2>
<p data-delete-message>Its file is removed from OpenVibe.Media too. This cannot be undone.</p>
<form method="post" data-delete-form><input type="hidden" name="confirm" value="1">
<p class="ovv-sheet-actions"><button class="ovv-btn ovv-btn--danger" type="submit">Delete for good</button> <button class="ovv-btn" type="button" data-delete-cancel>Keep it</button></p></form>
</dialog>`,
        });
    });

    r.post('/me/videos/share-default', mustSignIn('/me/videos', 'Sign in to change video sharing.'), async (req, res) => {
        if (!sameSite(req, res, '/me/videos')) return;
        const audience = String(req.body.audience || '');
        if (!ctx.sharing.AUDIENCES.includes(audience)) return res.status(422).type('text/plain').send('Choose a sharing audience.');
        const owner = ownerOf(req);
        await ctx.sharing.setDefaultAudience(owner, 'video', audience);
        if (req.body.apply === '1') await ctx.sharing.applyDefault(owner, 'video', audience);
        return res.redirect(303, '/me/videos');
    });

    // The numbered address answers 301 to the watch address, so an old link or card still lands on the video.
    r.get('/u/:id', async (req, res) => {
        let row = await visibleUpload(req, res, String(req.params.id || ''));
        if (!row) return undefined;
        if (row.status === 'processing') row = await up.refresh(row);
        const watchId = row.watch_id || await up.ensureWatchId(row);
        if (!watchId) return renderUpload(req, res, row);
        const tail = queryTail(req.query);
        return res.redirect(301, `/watch?v=${watchId}${tail}`);
    });

    async function maySeeUpload(req, row) {
        const who = whoOf(req);
        if (!row || row.state === 'removed') return false;
        // Specific people and Only me: the share row decides, beside the old column. A row written before the
        // sharing model (an import, a cut) does not exist yet: the column still decides, failing closed for private.
        const own = Boolean(who.requester && row.owner === who.requester);
        if (own || who.staff) return true;
        if (row.state !== 'active' || row.status !== 'ready') return false;
        if (ctx.sharing) {
            const share = await ctx.sharing.shareOf('video', row.id).catch(() => null);
            if (share) return await ctx.sharing.canView(req.viewer, 'video', row.id).catch(() => false);
        }
        return up.canSee(row, who);
    }

    /** The upload a request may see (its owner, staff, a share's people, the public), or null (and 404). */
    async function visibleUpload(req, res, id) {
        const row = await up.byId(id);
        if (!await maySeeUpload(req, row)) { notFound(req, res); return null; }
        return row;
    }

    async function uploadThread(req, row, watchPath) {
        if (row.state !== 'active' || row.status !== 'ready') return '';
        const subject = signedIn(req) ? req.viewer.subject : null;
        const staff = signedIn(req) && (isStaff(req) || row.owner === ownerOf(req));
        try {
            const answer = await comments.read(row, { subject, staff, sort: commentSort(req), after: commentAfter(req), ip: req.ip });
            const expandedId = /^\d{1,15}$/.test(String(req.query.replies || '')) ? String(req.query.replies) : null;
            const belongs = expandedId && answer.comments.some((c) => String(c.id) === expandedId);
            let expandedReplies = null;
            if (belongs) {
                expandedReplies = [];
                let cursor = null;
                do {
                    const more = await comments.read(row, { subject, staff, parent: expandedId, after: cursor, limit: 100, ip: req.ip });
                    expandedReplies.push(...more.comments);
                    if (more.next_cursor === cursor) break;
                    cursor = more.next_cursor;
                } while (cursor);
            }
            const shown = row.visibility === 'private' ? { ...answer, thread: {} } : answer;
            return raw(renderThread({ answer: shown, base: watchPath, post: `/u/${row.id}/comments?sort=${commentSort(req)}`,
                remove: `/u/${row.id}/comments/delete?sort=${commentSort(req)}`, signedIn: Boolean(subject) && answer.viewer.can_comment !== false,
                sort: commentSort(req), replyId: req.query.reply, expandedId: belongs ? expandedId : null, expandedReplies }));
        } catch (err) {
            return raw(`<section class="ovc-thread" id="comments"><h2>Comments</h2><p>${err instanceof CommentError && err.status === 404 ? 'Comments are hidden here.' : 'Comments are unavailable right now.'}</p></section>`);
        }
    }

    /** A query as the tail of /watch?v=<id> (its own ?v= is never carried): ?t= a moment, ?list= a playlist. */
    function queryTail(query) {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(query || {})) {
            if (k === 'v') continue;
            for (const x of (Array.isArray(v) ? v : [v])) if (x != null) qs.append(k, String(x));
        }
        const s = qs.toString();
        return s ? `&${s}` : '';
    }

    /**
     * One watch root for recordings, clips and uploads: /watch?v=<watch id>. Media resolves an id to its VOD or clip
     * (one id space across the two); an upload of this tenant is its Media VOD, so it renders the upload page, and a
     * Live recording or clip renders as it did on /v/:id or /c/:id. A local row answers even when Media is unreachable.
     */
    r.get('/watch', async (req, res) => {
        const watchId = String(req.query.v || '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(watchId)) return notFound(req, res);
        let row = await up.byWatchId(watchId);
        let ref = row ? { kind: 'vod', id: Number(row.media_vod_id) } : null;
        if (!ref) {
            const out = await ctx.media.watchResolve(watchId);
            if (out.ok && out.data && (out.data.kind === 'vod' || out.data.kind === 'clip') && Number.isSafeInteger(Number(out.data.id))) ref = out.data;
        }
        if (!ref) return notFound(req, res);
        if (ref.kind === 'clip') return h.renderClip(req, res, String(ref.id));
        row = row || await up.byMediaVod(Number(ref.id));
        if (row) {
            const visible = await visibleUpload(req, res, row.id);
            if (!visible) return undefined;
            return renderUpload(req, res, visible);
        }
        return h.renderVod(req, res, String(ref.id));
    });

    /** An upload's watch page, rendered (as /watch?v=<watch id>, or by its /u/<id> until it has an id). */
    async function renderUpload(req, res, row) {
        const who = whoOf(req);
        const own = Boolean(who.requester && row.owner === who.requester);
        const manage = own || who.staff;
        const share = manage && ctx.sharing ? await ctx.sharing.shareOf('video', row.id).catch(() => null) : null;
        const currentAudience = share ? share.audience : row.visibility === 'unlisted' ? 'link' : row.visibility;
        const ready = row.status === 'ready';
        const vod = ready ? await up.playback(row) : null;
        const ai = ready ? await ctx.videoAi.forUpload(row) : null;
        // Done, or asked again for a summary with its first run's captions and chapters kept (ai-edit.js).
        const aiDone = Boolean(ai && (ai.status === 'done' || (Array.isArray(ai.segments) && ai.segments.length)));
        const tracks = aiDone ? html`${ai.segments.length ? html`<track kind="captions" label="Captions (AI)" src="/u/${row.id}/captions.vtt" default>` : ''}${ai.chapters.length ? html`<track kind="chapters" src="/u/${row.id}/chapters.vtt">` : ''}` : '';
        if (ready && !own) await up.view(row);
        const listed = ready && row.state === 'active' && row.visibility === 'public';
        const channel = row.owner_username;
        // What this video is (the market outcomes): an upload, the day it was uploaded, how long it is, how many people
        // watched it. The channel is in the byline under the title.
        const what = whatItIs({
            kind: 'upload',
            publishedAt: row.created_at,
            durationSeconds: row.duration_seconds,
            views: Number(row.views) || 0,
        });
        const thumb = httpsUrl(row.thumbnail_url);
        // The page's one address: /watch?v=<watch id> (its /u/<id> redirects here until an id exists).
        const watchPath = row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`;
        const commentsHtml = await uploadThread(req, row, watchPath);
        if (row.status === 'processing') res.set('Refresh', '15');   // the page reloads itself until Media is done
        // Playlists (kind upload, by seq): a ready video anyone else may watch can be saved, and ?list= plays the next one.
        const saveForm = ready && row.state === 'active' && row.visibility !== 'private' && playlistForm ? await playlistForm(req, 'upload', row.seq) : '';
        const inList = upNext ? await upNext(req, 'upload', row.seq) : { html: '', nextUrl: null };
        const nextAttr = inList.nextUrl ? html` data-ovv-next="${inList.nextUrl}"` : '';
        // The AI cut (server/video/cut.js): the owner's panel, and the original an edited copy came from.
        const cutsOn = Boolean(own && ctx.videoCuts && ctx.videoCuts.enabled && ready && row.state === 'active' && !row.edited_from);
        const cuts = cutsOn ? await ctx.videoCuts.forUpload(row) : [];
        const cutBusy = cuts.some((c) => ['queued', 'measuring', 'rendering'].includes(c.status));
        const reel = cutsOn ? await ctx.videoCuts.highlightsPlan(row) : null;
        const original = own && row.edited_from ? await up.byId(row.edited_from) : null;
        if (cutBusy) res.set('Refresh', '15');
        // The description search results and share cards show: the uploader's own words when they say enough. A short one
        // ("Wheeeee", SEO audit 11-03) is kept and followed by the AI's overview when there is one, or by who made the
        // video, when and how long it is, so the snippet says what the page is.
        const said = String(row.description || '').trim();
        const { lengthWords, dayLabel } = require('./watch-ui');
        const madeBy = `A video by @${channel || 'someone'} on OpenVibe.Video${dayLabel(row.created_at) ? `, uploaded ${dayLabel(row.created_at)}` : ''}${lengthWords(row.duration_seconds) ? `, ${lengthWords(row.duration_seconds)} long` : ''}.`;
        const about = said.length >= 50 ? said.slice(0, 300)
            : [said ? `${said.replace(/[\s.!?…]+$/u, '')}.` : '', aiDone && ai.overview && !isFactsOverview(ai.overview) ? String(ai.overview).trim() : madeBy].filter(Boolean).join(' ').slice(0, 300);
        // 4.x (the owner's phone, 11-18: "Unlisted or public?", "so much crap", "can't edit", "not sleek like YouTube",
        // "needs … more from this user … sections that help SEO and discovery", "transcripts and AI overview and chapters …
        // should apply to all videos"): the upload's page is the recording's page. The title with who can see it and Edit
        // under it for the owner; one row of actions (Save, Share, More: Watch together, Ask your agent); the description
        // box with the facts, the words and the AI summary; chapters and the transcript beside the player; More from the
        // channel and related videos down the side. Edit opens the panel under the player: title, description, who can see
        // it, the AI's edited copies and Studio.
        const staffOnly = manage && !own;
        // Likes (11-18): an upload is liked like a recording, by its number.
        const likes = ready && likeButton && likesOf ? await likesOf(req, 'upload', row.seq).catch(() => null) : null;
        const aiSummary = aiDone && ai.overview && !isFactsOverview(ai.overview) ? String(ai.overview).trim() : '';
        const chapterList = aiDone ? chapterRows(ai.chapters) : [];
        const lines = aiDone ? transcriptLines(ai.segments) : [];
        const side = ready ? companion({ kind: 'upload', id: row.id, watchId: row.watch_id || null, chat: null, chapters: chapterList.length > 1 ? chapterList : [],
            transcript: lines, long: Number(row.duration_seconds) >= 3600, downloads: false,
            notes: { chapters: 'Made by AI from the video', transcript: 'Written by AI from the audio — it can be wrong' } }) : null;
        const channelRows = ready && channel ? await up.channel(channel, 49).catch(() => []) : [];
        const channelCount = channelRows.length + (channelRows.some((x) => x.id === row.id) || !listed ? 0 : 1);
        const moreRows = channelRows.filter((x) => x.id !== row.id).slice(0, 8);
        // What the box says when nobody wrote a description: the summary, else the video's first words, in quotes.
        const firstWords = lines.length ? lines.slice(0, 3).map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim() : '';
        const opening = firstWords ? `“${firstWords.length > 170 ? `${firstWords.slice(0, 168).replace(/\s+\S*$/, '')}…` : firstWords}”` : '';
        const livePublic = String((ctx.config.video && ctx.config.video.livePublicUrl) || 'https://openvibe.live').replace(/\/+$/, '');
        const relatedRows = ready ? await relatedTo(row, moreRows, 8).catch(() => []) : [];
        const sideCards = (id, title, rows, link) => (rows.length ? html`<section class="ovv-panel ovv-also" aria-labelledby="${id}"><header class="ovv-panel-head"><h2 id="${id}">${title}</h2>${link || ''}</header><div class="ovv-grid ovv-grid--side ovv-rail">${rows.map(uploadCard)}</div></section>` : '');
        const ownerBar = manage ? html`<div class="ovv-ownerbar${staffOnly ? ' is-staff' : ''}" role="group" aria-label="${staffOnly ? 'Staff tools on this video' : 'Your video'}">${staffOnly
            ? html`<span class="ovv-ownerbar-who is-staff"><i class="ovg-fill" data-ov-icon="key" aria-hidden="true"></i> As staff${channel ? html` · @${channel}'s video` : ''}</span>`
            : html`<span class="ovv-ownerbar-who"><i class="ovg-fill" data-ov-icon="user" aria-hidden="true"></i> Your video</span>`}<a class="ovv-vis-link" href="#manage" data-ovv-open="manage" title="Change who can see it">${visibilityBadge(row.visibility)}</a><span class="ovv-ownerbar-tools">${editButton('video')}${deleteAction({ action: `/u/${row.id}`, what: 'video' })}</span></div>` : '';
        const studio = own && ready && row.state === 'active' && studioVideoEdit ? html`<a class="ovv-btn" href="${studioEditUrl(row)}"><i class="ovg-fill" data-ov-icon="scissors" aria-hidden="true"></i> Trim and cover in Studio</a>` : '';
        const ownerPanel = manage ? html`<details class="ovv-panel ovv-owner" id="manage"${req.query.edit === '1' ? raw(' open') : ''}><summary><h2 id="h-owner"><i class="ovg-fill" data-ov-icon="pencil" aria-hidden="true"></i> Edit this video</h2><span class="ovv-fine">Title, description, who can see it</span></summary>
<form class="ovv-owner-form" method="post" action="/u/${row.id}/manage">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" value="${row.title}" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="4" maxlength="5000" placeholder="What is it about? Words people search for help them find it.">${row.description}</textarea></label>
${own && currentAudience === 'people' ? html`<label class="ovv-field"><span>Who can see it</span><select name="audience">${audienceOptions(currentAudience)}</select></label>` : visibilityChoices(VIS.includes(row.visibility) ? row.visibility : 'public')}
<button class="ovv-btn ovv-btn--primary" type="submit">Save changes</button>
</form>
${aiSummary && aiSummary !== row.description ? html`<form class="ovv-owner-ai" method="post" action="/u/${row.id}/manage"><input type="hidden" name="description" value="${aiSummary}"><p class="ovv-fine"><span class="ovv-ai-chip">AI summary</span> ${aiSummary}</p><button class="ovv-btn ovv-btn--small" type="submit">Use it as the description</button></form>` : ''}
${studio ? html`<p class="ovv-owner-studio">${studio}</p>` : ''}
${cutsOn ? cutPanel(row, cuts, cutBusy, reel) : ''}
</details>` : '';
        return page(req, res, {
            index: listed, noindex: !listed,
            ...(listed ? {} : { cache: cache.htmlHeaders({ private: true }) }),
            title: row.title,
            styles: ['kit.css', 'thread.css', 'thread-inline.css'],
            localStyles: [],
            description: about,
            canonical: `${ctx.config.video.url}${watchPath}`,
            ...(listed && thumb ? { image: thumb, ogType: 'video.other' } : {}),
            scripts: ready ? ['js/video.js', 'js/comments.js'] : [],
            player: !!(ready && vod),
            body: html`<div class="ovv-watch ovv-watch--vod ovv-watch--upload">
<div class="ovv-col ovv-col--main">
<div class="ovv-stage">
${req.query.saved === '1' ? notice('Saved.', 'ok') : ''}${req.query.reported === '1' ? notice('Thanks: the report reached OpenVibe staff.', 'ok') : ''}
${row.state === 'hidden' ? notice('Hidden after reports: only you and OpenVibe staff can see it until staff decide.', 'warn') : ''}
${row.visibility === 'private' && ready ? notice('Private: only you (and OpenVibe staff) can see this video.', 'info') : ''}
${original && original.state !== 'removed' ? html`<p class="ovv-fine ovv-edited-from">An edited copy of <a href="${original.watch_id ? `/watch?v=${original.watch_id}` : `/u/${original.id}`}">${original.title}</a>, made by the AI cut.</p>` : ''}
${ready && vod ? html`<div class="ovv-player-wrap"><video class="ovv-player" data-ov-player controls preload="metadata" playsinline${thumb ? html` poster="${`${thumb}?w=1280&fmt=webp`}" data-ov-thumb="${`${thumb}?w=32&fmt=webp`}" data-ov-ambient` : ''} src="${fileOf(vod) || ''}" data-ovv-video${nextAttr}${hlsAttrs(vod)}>${tracks}</video></div>`
        : html`<div class="ovv-player-wrap ovv-processing" role="status">${row.status === 'processing' ? html`<p><span class="ov-mark" data-state="busy" data-size="18" data-tone="ink" aria-hidden="true"></span> Processing: OpenVibe.Media is making it playable. This page reloads by itself.</p>`
            : row.status === 'failed' ? html`<p>This upload could not be processed. ${row.error || ''}</p>`
                : html`<p>The upload stopped before the end (${row.parts_received} of ${row.parts_expected} parts). Upload the file again from <a href="/upload">Upload</a>.</p>`}</div>`}
<div class="ovv-head">
${titleLine('Upload', row.title)}
${ownerBar}
<div class="ovv-head-row">
${channel ? html`<div class="ovv-byline"><a class="ovv-avatar" href="/@${channel}" aria-hidden="true" tabindex="-1">${channel.slice(0, 1).toUpperCase()}${/^[A-Za-z0-9_]{1,32}$/.test(channel) ? html`<img src="${ctx.config.networkUrl}/avatar/${channel}" alt="" loading="lazy">` : ''}</a><div class="ovv-byline-text"><a class="ovv-channel-name" href="/@${channel}">@${channel}</a><span class="ovv-meta">${channelCount > 48 ? '48+ videos' : `${channelCount} ${channelCount === 1 ? 'video' : 'videos'}`}<span data-ovv-followers="${channel}" hidden></span></span></div>${own ? '' : html`<a class="ovv-btn ovv-follow" href="${livePublic}/@${channel}" data-ovv-follow="${channel}" aria-pressed="false" title="Follow @${channel}"><i class="ovg-fill" data-ov-icon="plus" aria-hidden="true"></i> <span class="ovv-follow-w">Follow</span></a>`}</div>` : ''}
${ready ? html`<div class="ovv-actions-shell"><div class="ovv-actions">${likes ? likeButton(likes, 'upload', row.seq) : ''}${saveForm}${raw(shareButton({ cls: 'ovv-btn', url: `${ctx.config.video.url}${watchPath}`, title: row.title, text: about, image: thumb || '', timeFrom: vod ? '.ovv-player' : null, kind: 'video', id: row.id }))}${watchMore({ path: watchPath, kind: 'video', items: [], extras: html`${vod ? partyLink(watchPath, row.title, vod) : ''}${raw(askAgent({ text: `About the video “${row.title}” on OpenVibe.Video (${ctx.config.video.url}${watchPath}): ` }))}` })}</div></div>` : ''}
</div>
</div>
</div>
${ownerPanel}
${watchAbout({ facts: watchFacts(row.views, row.created_at, row.duration_seconds, row.visibility), description: said || aiSummary || opening || (manage ? 'No description yet: add one with Edit.' : 'No description yet.'), ai: said ? aiSummary : '', path: watchPath, chapters: [],
        from: html`${!said && manage ? html`<p class="ovv-about-from"><a href="#manage" data-ovv-open="manage">Add a description</a>: the words people search for help them find it.</p>` : ''}${manage && ready && ai && (ai.status === 'queued' || ai.status === 'running') ? html`<p class="ovv-about-from">Captions, chapters and a summary are being made by OpenVibe.AI.</p>` : ''}` })}
<section class="ovv-panel ovv-comments">${commentsHtml}</section>
${!own && ready ? html`<details class="ovv-panel ovv-report"><summary>Report this video</summary>
<form method="post" action="/u/${row.id}/report">
<fieldset><legend>What is wrong?</legend>${Object.entries(REASON_TEXT).map(([k, t]) => html`<label class="ovv-radio"><input type="radio" name="reason" value="${k}" required> ${t}</label>`)}</fieldset>
<label class="ovv-field"><span>Anything staff should know (optional)</span><textarea name="note" rows="2" maxlength="1000"></textarea></label>
<button class="ovv-btn" type="submit">Send the report</button>
<p class="ovv-fine">A child-safety report hides the video at once; three reports hide it until staff decide.</p></form></details>` : ''}
</div>
<aside class="ovv-col ovv-col--side">
${side || ''}
${inList.html}
${sideCards('h-more', channel ? `More from @${channel}` : 'More from this channel', moreRows, channel ? html`<a class="ovv-panel-link" href="/@${channel}">All videos</a>` : '')}
${sideCards('h-related', 'Related videos', relatedRows, html`<a class="ovv-panel-link" href="/">More</a>`)}
</aside>
</div>`,
        });
    }

    /** Videos like this one for its side (anyone may see them): public ones whose titles share its words, most watched
     *  first, then the newest; never this one, nor those already under More from the channel. */
    async function relatedTo(row, already = [], limit = 8) {
        const skip = new Set([row.id, ...already.map((x) => x.id)]);
        const words = [...new Set((String(row.title || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !RELATED_STOP.has(w)))].slice(0, 6);
        const out = [];
        if (words.length) {
            const hits = await ctx.s.db.many(`SELECT * FROM video_uploads WHERE visibility = 'public' AND status = 'ready' AND state = 'active' AND id <> $1
                AND (${words.map((_, i) => `lower(title) LIKE $${i + 2}`).join(' OR ')}) ORDER BY views DESC, id DESC LIMIT ${limit * 2}`, [row.id, ...words.map((w) => `%${w}%`)]);
            for (const x of hits) if (!skip.has(x.id) && out.length < limit) { out.push(x); skip.add(x.id); }
        }
        if (out.length < limit) for (const x of await up.latest(limit * 3)) if (!skip.has(x.id) && out.length < limit) { out.push(x); skip.add(x.id); }
        return out;
    }

    // The AI's transcript and chapters as WebVTT tracks, for whoever may see the video.
    async function aiOf(req) {
        const row = await up.byId(req.params.id);
        if (!await maySeeUpload(req, row) || row.status !== 'ready') return null;
        const ai = await ctx.videoAi.forUpload(row);
        return ai && (ai.status === 'done' || (Array.isArray(ai.segments) && ai.segments.length)) ? { row, ai } : null;
    }
    r.get('/u/:id/captions.vtt', async (req, res) => {
        const x = await aiOf(req);
        return x && x.ai.segments.length ? sendVtt(res, renderCaptionsVtt(x.ai.segments)) : notFoundVtt(req, res);
    });
    r.get('/u/:id/chapters.vtt', async (req, res) => {
        const x = await aiOf(req);
        return x && x.ai.chapters.length ? sendVtt(res, renderChaptersVtt(x.ai.chapters.map((c) => ({ offset_seconds: c.start, description: c.title })), x.row.duration_seconds)) : notFoundVtt(req, res);
    });

    const commentFailure = (req, res, row, err) => page(req, res, { title: 'Comment not sent',
        body: html`<h1>Comment not sent</h1><p>${err.message}</p><p><a href="${row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`}#comments">Go back</a></p>`,
    }, err.status && err.status >= 400 && err.status <= 599 ? err.status : 422);
    const commentReturn = (row, sort) => {
        const path = row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`;
        return `${path}${path.includes('?') ? '&' : '?'}sort=${sort}#comments`;
    };
    r.post('/u/:id/comments', mustSignIn('here', 'Sign in to comment.'), commentLimit, commentMultipart, async (req, res) => {
        const row = await visibleUpload(req, res, req.params.id);
        if (!row) return undefined;
        if (!sameSite(req, res, commentReturn(row, commentSort(req)))) return undefined;
        if (row.state !== 'active' || row.status !== 'ready') return notFound(req, res);
        try {
            const form = await readCommentForm(req);
            const attachments = [];
            for (const file of form.files) {
                const out = await comments.upload(row, req.viewer.subject, file, req.ip);
                if (!out || !out.attachment) throw new CommentError(503, 'The attachment could not be saved');
                attachments.push(out.attachment);
            }
            await comments.add(row, req.viewer.subject, { message: form.message, parent_id: form.parent_id, attachments }, req.ip);
            return res.redirect(303, commentReturn(row, commentSort(req)));
        } catch (err) { return commentFailure(req, res, row, err); }
    });
    r.post('/u/:id/comments/delete', mustSignIn('here', 'Sign in to remove a comment.'), commentLimit, async (req, res) => {
        const row = await visibleUpload(req, res, req.params.id);
        if (!row) return undefined;
        if (!sameSite(req, res, commentReturn(row, commentSort(req)))) return undefined;
        const id = String(req.body.comment_id || '');
        if (!/^\d{1,15}$/.test(id)) return notFound(req, res);
        try {
            await comments.remove(row, req.viewer.subject, isStaff(req) || row.owner === ownerOf(req), id, req.ip);
            return res.redirect(303, commentReturn(row, commentSort(req)));
        } catch (err) { return commentFailure(req, res, row, err); }
    });

    r.post('/u/:id/manage', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || !(row.owner === who.requester || who.staff)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        try {
            const b = req.body || {};
            await up.update(row, { title: b.title === undefined ? undefined : b.title, description: b.description, visibility: b.visibility === undefined ? undefined : b.visibility, audience: b.audience === undefined ? undefined : b.audience });
        } catch (err) {
            if (!(err instanceof UploadError || err instanceof ShareError)) throw err;
            return page(req, res, { title: 'Not saved', body: html`<h1>Not saved</h1><p>${err.detail}</p><p><a href="${row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`}">Back</a></p>` }, err.status);
        }
        if (ctx.videoSearch) ctx.videoSearch.kick();
        return res.redirect(303, `/u/${row.id}?saved=1`);
    });

    r.post('/u/:id/cut', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || row.owner !== who.requester) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        try {
            await ctx.videoCuts.request(row, who, String((req.body || {}).mode || 'pauses'));
        } catch (err) {
            if (!(err instanceof UploadError)) throw err;
            return page(req, res, { title: 'Not started', body: html`<h1>The cut did not start</h1><p>${err.detail}</p><p><a href="${row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`}">Back to the video</a></p>` }, err.status);
        }
        return res.redirect(303, `/u/${row.id}#h-cut`);
    });

    r.post('/u/:id/delete', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || !(row.owner === who.requester || who.staff)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        if ((req.body || {}).confirm !== '1') return res.redirect(303, `/u/${row.id}`);
        await up.remove(row);
        if (ctx.videoSearch) ctx.videoSearch.kick();
        return res.redirect(303, '/me/videos');
    });

    r.post('/u/:id/report', async (req, res) => {
        const row = await up.byId(req.params.id);
        if (!await maySeeUpload(req, row)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        try {
            const b = req.body || {};
            await up.report(row, { reporter: signedIn(req) ? ownerOf(req) : up.addressId(req.ip), reason: String(b.reason || ''), note: b.note });
        } catch (err) {
            if (!(err instanceof UploadError)) throw err;
            return page(req, res, { title: 'Not sent', body: html`<h1>Not sent</h1><p>${err.detail}</p><p><a href="${row.watch_id ? `/watch?v=${row.watch_id}` : `/u/${row.id}`}">Back</a></p>` }, err.status);
        }
        if (ctx.videoSearch) ctx.videoSearch.kick();
        return res.redirect(303, `/u/${row.id}?reported=1`);
    });

    return uploadCard;

    /** A card for an upload (home, channel, the watch page's side). */
    function uploadCard(x) {
        return card({
            href: x.watch_id ? `/watch?v=${x.watch_id}` : `/u/${x.id}`, thumb: httpsUrl(x.thumbnail_url), title: x.title,
            channel: x.owner_username || null, channelHref: x.owner_username ? `/@${x.owner_username}` : null,
            duration: x.duration_seconds ? durationLabel(x.duration_seconds) : null,
            date: dateLabel(x.ready_at || x.created_at) || null, iso: x.ready_at || x.created_at || null,
        });
    }
}

module.exports = { createUploadApi, mountUploadPages, REASON_TEXT };
