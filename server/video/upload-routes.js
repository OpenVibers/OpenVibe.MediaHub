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
const cache = require('openvibe-shared/cache-policy');
const { sameOrigin } = require('../http/principal');
const { html, raw, notice, askAgent } = require('../render/html');
const { UploadError } = require('./uploads');

const REASON_TEXT = {
    child_safety: 'It sexualises or endangers a child', violence: 'Violence or a threat', harassment: 'Harassment or someone\'s private details',
    sexual: 'Sexual content', copyright: 'It is my work, used without permission', spam: 'Spam or a scam', other: 'Something else',
};

function problem(res, err) {
    const e = err instanceof UploadError ? err : null;
    if (!e) throw err;
    return res.status(e.status).type('application/problem+json').json({ type: 'about:blank', status: e.status, code: e.code, detail: e.detail });
}

/** The JSON part API (mounted before the site's urlencoded parser: parts are raw bytes). */
function createUploadApi({ ctx, config }) {
    const up = ctx.videoUploads;
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
            const row = await up.start(who(req), { title: b.title, description: b.description, visibility: b.visibility, size: b.size, contentType: b.content_type, name: b.name });
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
            const updated = await up.update(row, { title: b.title, description: b.description, visibility: b.visibility });
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
            const row = await up.startRecording(who(req), { title: b.title, description: b.description, visibility: b.visibility, contentType: b.content_type });
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
            return res.status(202).json({ video: { id: out.id, status: out.status, url: out.watch_id ? `/watch?v=${out.watch_id}` : `/u/${out.id}` } });
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
    const { ctx, page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, visibilityOptions, visibilityLabel, durationLabel, dateLabel, httpsUrl, fileOf, hlsAttrs, grid, card, renderCaptionsVtt, renderChaptersVtt, vttTime, sendVtt, notFoundVtt, playlistForm, upNext, whatItIs, shareButton, renderVod, renderClip } = h;
    const up = ctx.videoUploads;
    const cfg = ctx.config.videoUploads;
    const whoOf = (req) => ({ requester: signedIn(req) ? ownerOf(req) : null, staff: isStaff(req) });
    const GB = 1024 ** 3;

    const statusText = (row) => (row.state === 'hidden' ? 'Hidden after reports, waiting for staff'
        : row.status === 'uploading' ? `Upload stopped at ${Math.round((row.parts_received / row.parts_expected) * 100)}%`
            : row.status === 'processing' ? 'Processing' : row.status === 'failed' ? 'Failed' : visibilityLabel(row.visibility));

    const CUT_STATUS = { queued: 'Waiting to start', measuring: 'Finding the pauses', rendering: 'Making the copy' };
    const CUT_LABEL = { pauses: 'Pauses cut', tight: 'Tight cut', highlights: 'Highlights reel' };
    function cutLine(c) {
        const what = html`<b>${CUT_LABEL[c.mode] || c.mode}</b>`;
        if (c.status === 'done') {
            const shorter = c.source_seconds && c.kept_seconds ? html` · ${durationLabel(c.source_seconds)} → ${durationLabel(c.kept_seconds)}` : '';
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
<div data-ov-upload-picker></div>
<ov-progress data-ov-upload-progress></ov-progress>
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="4" maxlength="5000"></textarea></label>
<fieldset class="ovv-visibility"><legend>Who can see it?</legend>
<label><input type="radio" name="visibility" value="public" checked><span><b>Public</b><small>Anyone can find and watch it.</small></span></label>
<label><input type="radio" name="visibility" value="unlisted"><span><b>Unlisted</b><small>Only people with the link.</small></span></label>
<label><input type="radio" name="visibility" value="private"><span><b>Only you</b><small>Your private video.</small></span></label></fieldset>
<p class="ovv-fine">Upload only what you may share. <button type="button" class="ovv-link-button" data-upload-rules>Rules and limits</button></p>
<p class="ovv-upload-status" role="status" aria-live="polite"></p>
<button class="ovv-btn ovv-btn--primary" type="submit" disabled>Save details</button>
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
<label class="ovv-field"><span>Who can see it</span><select name="visibility">${visibilityOptions('private')}</select></label>
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
        return page(req, res, {
            title: 'Your videos',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your videos' }],
            body: html`<h1>Your videos</h1>
<p><a class="ovv-btn ovv-btn--primary" href="/upload"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload a video</a></p>
${fresh.length ? html`<table class="ovv-table"><thead><tr><th scope="col">Video</th><th scope="col">State</th><th scope="col">Length</th><th scope="col">Views</th><th scope="col">Uploaded</th></tr></thead><tbody>
${fresh.map((x) => html`<tr><td><a href="${x.watch_id ? `/watch?v=${x.watch_id}` : `/u/${x.id}`}">${x.title}</a></td><td>${statusText(x)}</td><td>${x.duration_seconds ? durationLabel(x.duration_seconds) : ''}</td><td>${Number(x.views) || 0}</td><td>${dateLabel(x.created_at) || ''}</td></tr>`)}
</tbody></table>` : html`<p class="muted">Nothing uploaded yet.</p>`}`,
        });
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

    /** The upload a request may see (its owner, staff, a share's people, the public), or null (and 404). */
    async function visibleUpload(req, res, id) {
        const row = await up.byId(id);
        const who = whoOf(req);
        if (!up.canSee(row, who)) { notFound(req, res); return null; }
        // Specific people and Only me: the share row decides, beside the old column. A row written before the
        // sharing model (an import, a cut) does not exist yet: the column still decides, failing closed for private.
        const own = Boolean(who.requester && row.owner === who.requester);
        if (!own && !who.staff && ctx.sharing) {
            const share = await ctx.sharing.shareOf('video', row.id).catch(() => null);
            if (share && !await ctx.sharing.canView(req.viewer, 'video', row.id).catch(() => false)) { notFound(req, res); return null; }
        }
        return row;
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
        const ready = row.status === 'ready';
        const vod = ready ? await up.playback(row) : null;
        const ai = ready ? await ctx.videoAi.forUpload(row) : null;
        const aiDone = Boolean(ai && ai.status === 'done');
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
            : [said ? `${said.replace(/[\s.!?…]+$/u, '')}.` : '', aiDone && ai.overview ? String(ai.overview).trim() : madeBy].filter(Boolean).join(' ').slice(0, 300);
        return page(req, res, {
            index: listed, noindex: !listed,
            ...(listed ? {} : { cache: cache.htmlHeaders({ private: true }) }),
            title: row.title,
            styles: ['kit.css'],
            description: about,
            canonical: `${ctx.config.video.url}${watchPath}`,
            ...(listed && thumb ? { image: thumb, ogType: 'video.other' } : {}),
            scripts: ready ? ['js/video.js'] : [],
            player: !!(ready && vod),
            body: html`<div class="ovv-watch">
<div class="ovv-main">
${req.query.saved === '1' ? notice('Saved.', 'ok') : ''}${req.query.reported === '1' ? notice('Thanks: the report reached OpenVibe staff.', 'ok') : ''}
${row.state === 'hidden' ? notice('Hidden after reports: only you and OpenVibe staff can see it until staff decide.', 'warn') : ''}
${row.visibility === 'private' && ready ? notice('Private: only you (and OpenVibe staff) can see this video.', 'info') : ''}
${original && original.state !== 'removed' ? html`<p class="ovv-fine ovv-edited-from">An edited copy of <a href="${original.watch_id ? `/watch?v=${original.watch_id}` : `/u/${original.id}`}">${original.title}</a>, made by the AI cut.</p>` : ''}
${ready && vod ? html`<div class="ovv-player-wrap"><video class="ovv-player" data-ov-player controls preload="metadata" playsinline${thumb ? html` poster="${`${thumb}?w=1280&fmt=webp`}" data-ov-thumb="${`${thumb}?w=32&fmt=webp`}" data-ov-ambient` : ''} src="${fileOf(vod) || ''}" data-ovv-video${nextAttr}${hlsAttrs(vod)}>${tracks}</video></div>`
        : html`<div class="ovv-player-wrap ovv-processing" role="status">${row.status === 'processing' ? html`<p><i class="fa-solid fa-gear fa-spin" aria-hidden="true"></i> Processing: OpenVibe.Media is making it playable. This page reloads by itself.</p>`
            : row.status === 'failed' ? html`<p>This upload could not be processed. ${row.error || ''}</p>`
                : html`<p>The upload stopped before the end (${row.parts_received} of ${row.parts_expected} parts). Upload the file again from <a href="/upload">Upload</a>.</p>`}</div>`}
<h1 class="ovv-title">${row.title}</h1>
${what}
<div class="ovv-byline">
${channel ? html`<a class="ovv-avatar" href="/@${channel}" aria-hidden="true" tabindex="-1">${channel.slice(0, 1).toUpperCase()}${/^[A-Za-z0-9_]{1,32}$/.test(channel) ? html`<img src="${ctx.config.networkUrl}/avatar/${channel}" alt="" loading="lazy">` : ''}</a>` : ''}
<div class="ovv-byline-text">${channel ? html`<a class="ovv-channel-name" href="/@${channel}">@${channel}</a>` : ''}
</div>
<div class="ovv-byline-actions">${saveForm}${ready && vod && fileOf(vod) ? html`<a class="ovv-btn" href="https://openvibe.party/new?media=${encodeURIComponent(fileOf(vod))}&source_url=${encodeURIComponent(`${String(ctx.config.video.url).replace(/\/+$/, '')}${watchPath}`)}&title=${encodeURIComponent(String(row.title || 'Watch party'))}"><i class="fa-solid fa-users" aria-hidden="true"></i> Watch together</a>` : ''}${raw(shareButton({ cls: 'ovv-btn', url: `${ctx.config.video.url}${watchPath}`, title: row.title, text: about, image: thumb || '', timeFrom: ready && vod ? '.ovv-player' : null }))}${raw(askAgent({ text: `About the video “${row.title}” on OpenVibe.Video (${ctx.config.video.url}${watchPath}): ` }))}</div>
</div>
${row.description ? html`<section class="ovv-panel ovv-description"><p>${row.description}</p></section>` : ''}
${aiDone && ai.overview ? html`<section class="ovv-panel" aria-labelledby="h-ai"><h2 id="h-ai">About this video</h2><p>${ai.overview}</p><p class="ovv-fine">Written by AI from the video's sound and pictures (OpenVibe.AI, run on OpenVibe's own servers).</p>
${manage && ai.overview !== row.description ? html`<form method="post" action="/u/${row.id}/manage"><input type="hidden" name="description" value="${ai.overview}"><button class="ovv-btn" type="submit">Use this as the description</button></form>` : ''}</section>` : ''}
${aiDone && ai.segments.length ? html`<details class="ovv-panel ovv-transcript"><summary>Transcript <span class="ovv-fine">(AI, ${ai.segments.length} lines)</span></summary><div class="ovv-transcript-body">${ai.segments.map((x) => html`<p><button type="button" class="ovv-seek" data-ovv-seek="${x.start}">${vttTime(x.start).slice(0, 8)}</button> <span>${x.text}</span></p>`)}</div></details>` : ''}
${manage && ready && ai && (ai.status === 'queued' || ai.status === 'running') ? html`<p class="ovv-fine">Captions, chapters and a summary are being made by OpenVibe.AI.</p>` : ''}
</div>
<aside class="ovv-side">
${inList.html}
${manage ? html`<section class="ovv-panel ovv-owner" aria-labelledby="h-owner"><h2 id="h-owner">Manage this video</h2>
<form class="ovv-owner-form" method="post" action="/u/${row.id}/manage">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" value="${row.title}" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="3" maxlength="5000">${row.description}</textarea></label>
<label class="ovv-field"><span>Visibility</span><select name="visibility">${visibilityOptions(row.visibility)}</select></label>
<button class="ovv-btn ovv-btn--primary" type="submit">Save changes</button></form>
<details class="ovv-danger"><summary>Delete this video</summary>
<form class="ovv-owner-delete" method="post" action="/u/${row.id}/delete"><label class="ovv-confirm"><input type="checkbox" name="confirm" value="1" required> I want to delete it for good</label> <button class="ovv-btn ovv-btn--danger" type="submit">Delete</button></form>
</details></section>` : ''}
${cutsOn ? cutPanel(row, cuts, cutBusy, reel) : ''}
${aiDone && ai.chapters.length > 1 ? html`<section class="ovv-panel ovv-chapters" aria-labelledby="h-chapters"><h2 id="h-chapters">Chapters</h2><ol>${ai.chapters.map((c) => html`<li><a href="${watchPath}?t=${c.start}" data-ovv-chapter="${c.start}"><span class="ovv-time">${vttTime(c.start).slice(0, 8)}</span><span>${c.title}</span></a></li>`)}</ol><p class="ovv-fine">From the video's highlights (AI).</p></section>` : ''}
${!own && ready ? html`<details class="ovv-panel ovv-report"><summary>Report this video</summary>
<form method="post" action="/u/${row.id}/report">
<fieldset><legend>What is wrong?</legend>${Object.entries(REASON_TEXT).map(([k, t]) => html`<label class="ovv-radio"><input type="radio" name="reason" value="${k}" required> ${t}</label>`)}</fieldset>
<label class="ovv-field"><span>Anything staff should know (optional)</span><textarea name="note" rows="2" maxlength="1000"></textarea></label>
<button class="ovv-btn" type="submit">Send the report</button>
<p class="ovv-fine">A child-safety report hides the video at once; three reports hide it until staff decide.</p></form></details>` : ''}
</aside>
</div>`,
        });
    }

    // The AI's transcript and chapters as WebVTT tracks, for whoever may see the video.
    async function aiOf(req) {
        const row = await up.byId(req.params.id);
        if (!up.canSee(row, whoOf(req)) || row.status !== 'ready') return null;
        const ai = await ctx.videoAi.forUpload(row);
        return ai && ai.status === 'done' ? { row, ai } : null;
    }
    r.get('/u/:id/captions.vtt', async (req, res) => {
        const x = await aiOf(req);
        return x && x.ai.segments.length ? sendVtt(res, renderCaptionsVtt(x.ai.segments)) : notFoundVtt(req, res);
    });
    r.get('/u/:id/chapters.vtt', async (req, res) => {
        const x = await aiOf(req);
        return x && x.ai.chapters.length ? sendVtt(res, renderChaptersVtt(x.ai.chapters.map((c) => ({ offset_seconds: c.start, description: c.title })), x.row.duration_seconds)) : notFoundVtt(req, res);
    });

    r.post('/u/:id/manage', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || !(row.owner === who.requester || who.staff)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        try {
            const b = req.body || {};
            await up.update(row, { title: b.title === undefined ? undefined : b.title, description: b.description, visibility: b.visibility === undefined ? undefined : b.visibility });
        } catch (err) {
            if (!(err instanceof UploadError)) throw err;
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
        if (!up.canSee(row, whoOf(req))) return notFound(req, res);
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

    /** A card for an upload (home, channel). */
    return function uploadCard(x) {
        return card({
            href: x.watch_id ? `/watch?v=${x.watch_id}` : `/u/${x.id}`, thumb: httpsUrl(x.thumbnail_url), title: x.title,
            channel: x.owner_username || null, channelHref: x.owner_username ? `/@${x.owner_username}` : null,
            duration: x.duration_seconds ? durationLabel(x.duration_seconds) : null,
            date: dateLabel(x.ready_at || x.created_at) || null, iso: x.ready_at || x.created_at || null,
        });
    };
}

module.exports = { createUploadApi, mountUploadPages, REASON_TEXT };
