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
 *   GET  /me/videos                  your uploads, with their state
 *
 * Every write is a signed-in person's (a session on openvibe.video) from openvibe.video itself (Sec-Fetch-Site or
 * Origin). Reports are open to anyone who can see the video, one per person (or per keyed address) per video.
 */
const express = require('express');
const cache = require('openvibe-shared/cache-policy');
const { sameOrigin } = require('../http/principal');
const { html, notice } = require('../render/html');
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

    r.put('/:id/parts/:n', express.raw({ type: () => true, limit: `${Math.ceil(up.PART_SIZE / 1024) + 64}kb` }), async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const out = await up.part(row, Number(req.params.n), Buffer.isBuffer(req.body) ? req.body : null);
            return res.json({ parts_received: out.parts_received, parts_expected: out.parts_expected });
        } catch (err) { return problem(res, err); }
    });

    r.post('/:id/complete', async (req, res) => {
        if (!guard(req, res)) return undefined;
        const row = await own(req, res);
        if (!row) return undefined;
        try {
            const out = await up.complete(row);
            return res.status(202).json({ video: { id: out.id, status: out.status, url: `/u/${out.id}` } });
        } catch (err) { return problem(res, err); }
    });

    return r;
}

/** The pages; `h` carries the video site's helpers (page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, cards). */
function mountUploadPages(r, h) {
    const { ctx, page, notFound, signedIn, ownerOf, mustSignIn, sameSite, isStaff, visibilityOptions, visibilityLabel, durationLabel, dateLabel, httpsUrl, fileOf, hlsAttrs, grid, card } = h;
    const up = ctx.videoUploads;
    const cfg = ctx.config.videoUploads;
    const whoOf = (req) => ({ requester: signedIn(req) ? ownerOf(req) : null, staff: isStaff(req) });
    const GB = 1024 ** 3;

    const statusText = (row) => (row.state === 'hidden' ? 'Hidden after reports, waiting for staff'
        : row.status === 'uploading' ? `Upload stopped at ${Math.round((row.parts_received / row.parts_expected) * 100)}%`
            : row.status === 'processing' ? 'Processing' : row.status === 'failed' ? 'Failed' : visibilityLabel(row.visibility));

    r.get('/upload', mustSignIn('/upload', 'Uploads belong to your OpenVibe account: sign in to upload a video.'), async (req, res) => page(req, res, {
        title: 'Upload a video',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Upload' }],
        scripts: ['js/video-upload.js'],
        body: html`<h1>Upload a video</h1>
<form class="ovv-upload ovv-panel" data-video-upload method="post" action="/upload">
<label class="ovv-field"><span>Video file</span><input name="file" type="file" accept="video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv" required></label>
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="4" maxlength="5000"></textarea></label>
<label class="ovv-field"><span>Who can see it</span><select name="visibility">${visibilityOptions('public')}</select></label>
<p class="ovv-fine">Public is listed on your channel and searchable; unlisted opens only by its link; private only for you. MP4, MOV, WebM or MKV, up to ${Math.round(cfg.maxBytes / GB)} GB a video and ${Math.round(cfg.quotaBytes / GB)} GB in all, ${cfg.perDay} uploads a day. Upload only what you made or may share: reported videos are hidden while staff look.</p>
<progress hidden value="0" max="1"></progress>
<p class="ovv-upload-status" role="status" aria-live="polite"></p>
<button class="ovv-btn ovv-btn--primary" type="submit">Upload</button>
<noscript><p class="ovv-fine">Uploading needs JavaScript: a video goes up in parts so a big file and a dropped connection both work.</p></noscript>
</form>
<p><a href="/me/videos">Your videos</a></p>`,
    }));

    // Without JavaScript the form posts here: a video goes up in parts, which needs the page's script.
    r.post('/upload', (req, res) => page(req, res, {
        title: 'Upload a video',
        body: html`<h1>Uploading needs JavaScript</h1><p>A video goes up in 8 MB parts, so a big file and a dropped connection both work. Turn JavaScript on for openvibe.video and <a href="/upload">try again</a>.</p>`,
    }, 400));

    r.get('/me/videos', mustSignIn('/me/videos', 'Sign in to see the videos you uploaded.'), async (req, res) => {
        const rows = await up.mine(ownerOf(req));
        await Promise.all(rows.filter((x) => x.status === 'processing').map((x) => up.refresh(x).catch(() => null)));
        const fresh = await up.mine(ownerOf(req));
        return page(req, res, {
            title: 'Your videos',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your videos' }],
            body: html`<h1>Your videos</h1>
<p><a class="ovv-btn ovv-btn--primary" href="/upload"><i class="fa-solid fa-upload" aria-hidden="true"></i> Upload a video</a></p>
${fresh.length ? html`<table class="ovv-table"><thead><tr><th scope="col">Video</th><th scope="col">State</th><th scope="col">Length</th><th scope="col">Views</th><th scope="col">Uploaded</th></tr></thead><tbody>
${fresh.map((x) => html`<tr><td><a href="/u/${x.id}">${x.title}</a></td><td>${statusText(x)}</td><td>${x.duration_seconds ? durationLabel(x.duration_seconds) : ''}</td><td>${Number(x.views) || 0}</td><td>${dateLabel(x.created_at) || ''}</td></tr>`)}
</tbody></table>` : html`<p class="muted">Nothing uploaded yet.</p>`}`,
        });
    });

    r.get('/u/:id', async (req, res) => {
        let row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!up.canSee(row, who)) return notFound(req, res);
        if (row.status === 'processing') row = await up.refresh(row);
        const own = who.requester && row.owner === who.requester;
        const manage = own || who.staff;
        const ready = row.status === 'ready';
        const vod = ready ? await up.playback(row) : null;
        if (ready && !own) await up.view(row);
        const listed = ready && row.state === 'active' && row.visibility === 'public';
        const channel = row.owner_username;
        const metaParts = [row.ready_at ? html`<time datetime="${row.ready_at}">${dateLabel(row.ready_at)}</time>` : null, row.duration_seconds ? durationLabel(row.duration_seconds) : null, `${Number(row.views) || 0} views`].filter(Boolean);
        const thumb = httpsUrl(row.thumbnail_url);
        if (row.status === 'processing') res.set('Refresh', '15');   // the page reloads itself until Media is done
        return page(req, res, {
            index: listed, noindex: !listed,
            ...(listed ? {} : { cache: cache.htmlHeaders({ private: true }) }),
            title: row.title,
            description: row.description ? row.description.slice(0, 300) : `A video by @${channel || 'someone'} on OpenVibe.Video.`,
            ...(listed && thumb ? { image: thumb, ogType: 'video.other' } : {}),
            scripts: ready ? ['js/video.js'] : [],
            body: html`<div class="ovv-watch">
<div class="ovv-main">
${req.query.saved === '1' ? notice('Saved.', 'ok') : ''}${req.query.reported === '1' ? notice('Thanks: the report reached OpenVibe staff.', 'ok') : ''}
${row.state === 'hidden' ? notice('Hidden after reports: only you and OpenVibe staff can see it until staff decide.', 'warn') : ''}
${row.visibility === 'private' && ready ? notice('Private: only you (and OpenVibe staff) can see this video.', 'info') : ''}
${ready && vod ? html`<div class="ovv-player-wrap"><video class="ovv-player" controls preload="metadata" playsinline${thumb ? html` poster="${`${thumb}?w=1280&fmt=webp`}"` : ''} src="${fileOf(vod) || ''}" data-ovv-video${hlsAttrs(vod)}></video></div>`
        : html`<div class="ovv-player-wrap ovv-processing" role="status">${row.status === 'processing' ? html`<p><i class="fa-solid fa-gear fa-spin" aria-hidden="true"></i> Processing: OpenVibe.Media is making it playable. This page reloads by itself.</p>`
            : row.status === 'failed' ? html`<p>This upload could not be processed. ${row.error || ''}</p>`
                : html`<p>The upload stopped before the end (${row.parts_received} of ${row.parts_expected} parts). Upload the file again from <a href="/upload">Upload</a>.</p>`}</div>`}
<h1 class="ovv-title">${row.title}</h1>
<div class="ovv-byline">
${channel ? html`<a class="ovv-avatar" href="/@${channel}" aria-hidden="true" tabindex="-1">${channel.slice(0, 1).toUpperCase()}</a>` : ''}
<div class="ovv-byline-text">${channel ? html`<a class="ovv-channel-name" href="/@${channel}">@${channel}</a>` : ''}
${metaParts.length ? html`<span class="ovv-meta">${metaParts.map((p, i) => (i === 0 ? p : [html` · `, p]))}</span>` : ''}</div>
</div>
${row.description ? html`<section class="ovv-panel ovv-description"><p>${row.description}</p></section>` : ''}
</div>
<aside class="ovv-side">
${manage ? html`<section class="ovv-panel ovv-owner" aria-labelledby="h-owner"><h2 id="h-owner">Manage this video</h2>
<form class="ovv-owner-form" method="post" action="/u/${row.id}/manage">
<label class="ovv-field"><span>Title</span><input name="title" type="text" maxlength="120" value="${row.title}" required></label>
<label class="ovv-field"><span>Description</span><textarea name="description" rows="3" maxlength="5000">${row.description}</textarea></label>
<label class="ovv-field"><span>Visibility</span><select name="visibility">${visibilityOptions(row.visibility)}</select></label>
<button class="ovv-btn ovv-btn--primary" type="submit">Save changes</button></form>
<details class="ovv-danger"><summary>Delete this video</summary>
<form class="ovv-owner-delete" method="post" action="/u/${row.id}/delete"><label class="ovv-confirm"><input type="checkbox" name="confirm" value="1" required> I want to delete it for good</label> <button class="ovv-btn ovv-btn--danger" type="submit">Delete</button></form>
</details></section>` : ''}
${!own && ready ? html`<details class="ovv-panel ovv-report"><summary>Report this video</summary>
<form method="post" action="/u/${row.id}/report">
<fieldset><legend>What is wrong?</legend>${Object.entries(REASON_TEXT).map(([k, t]) => html`<label class="ovv-radio"><input type="radio" name="reason" value="${k}" required> ${t}</label>`)}</fieldset>
<label class="ovv-field"><span>Anything staff should know (optional)</span><textarea name="note" rows="2" maxlength="1000"></textarea></label>
<button class="ovv-btn" type="submit">Send the report</button>
<p class="ovv-fine">A child-safety report hides the video at once; three reports hide it until staff decide.</p></form></details>` : ''}
</aside>
</div>`,
        });
    });

    r.post('/u/:id/manage', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || !(row.owner === who.requester || who.staff)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        try {
            const b = req.body || {};
            await up.update(row, { title: b.title, description: b.description, visibility: b.visibility });
        } catch (err) {
            if (!(err instanceof UploadError)) throw err;
            return page(req, res, { title: 'Not saved', body: html`<h1>Not saved</h1><p>${err.detail}</p><p><a href="/u/${row.id}">Back</a></p>` }, err.status);
        }
        return res.redirect(303, `/u/${row.id}?saved=1`);
    });

    r.post('/u/:id/delete', mustSignIn('here'), async (req, res) => {
        const row = await up.byId(req.params.id);
        const who = whoOf(req);
        if (!row || row.state === 'removed' || !(row.owner === who.requester || who.staff)) return notFound(req, res);
        if (!sameSite(req, res, `/u/${row.id}`)) return undefined;
        if ((req.body || {}).confirm !== '1') return res.redirect(303, `/u/${row.id}`);
        await up.remove(row);
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
            return page(req, res, { title: 'Not sent', body: html`<h1>Not sent</h1><p>${err.detail}</p><p><a href="/u/${row.id}">Back</a></p>` }, err.status);
        }
        return res.redirect(303, `/u/${row.id}?reported=1`);
    });

    /** A card for an upload (home, channel). */
    return function uploadCard(x) {
        return card({
            href: `/u/${x.id}`, thumb: httpsUrl(x.thumbnail_url), title: x.title,
            channel: x.owner_username || null, channelHref: x.owner_username ? `/@${x.owner_username}` : null,
            duration: x.duration_seconds ? durationLabel(x.duration_seconds) : null,
            date: dateLabel(x.ready_at || x.created_at) || null, iso: x.ready_at || x.created_at || null,
        });
    };
}

module.exports = { createUploadApi, mountUploadPages, REASON_TEXT };
