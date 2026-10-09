'use strict';

/**
 * The pages of openvibe.download.
 *
 *   /                    what this is, the safety rules and how to sign in
 *   /files               your drive: folders, files, the usage bar, the upload form
 *   /files/:id           one file: its details, a share link, delete
 *   /files/:id/download  its bytes
 *   /s/:slug             a share link: what it is, who shared it, expiry, Download and Report
 *   /staff               the report queue (OpenVibe staff)
 *   /safety              the rules, what is not allowed, how reports work, the abuse contact
 *   /updates             the update log
 *
 * Every page works without JavaScript and is server-rendered through openvibe-shared/shell: the upload form, the
 * share form and the report form are plain POSTs. The one script is the chunked upload's progress meter
 * (public/js/upload.js), and the plain form submits by itself when it is not there.
 *
 * A signed-in write must come from openvibe.download itself (same-origin), exactly as in the API, and the form
 * takes the same per-caller budget as the API route it stands for, so it is not a way round a limit.
 *
 * Nothing here is hand-written copy about a file: a file's name is what its owner typed, escaped by the `html`
 * template and nothing else. No file's bytes are ever rendered into a page.
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, table, notice, time, badge } = require('../render/html');
const { send } = require('../render/layout');
const rules = require('../drive/rules');
const { isStaff } = require('../drive/staff');
const { boundaryOf, readFormData } = require('./form-upload');

const SITE_NAME = 'OpenVibe.MediaHub';
const TAGLINE = 'Your files, shared on your terms.';
const ABUSE_EMAIL = 'abuse@openvibe.network';
const DMCA_EMAIL = 'dmca@openvibe.network';

/** The rules, word for word: shown on / and /safety, so the two can never drift. */
const SAFETY_RULES = [
    'Anything you would not put in a public square does not belong here. This is a private drive with share links, not a place to hide.',
    'No malware, no phishing, no cracked software, no keygens, no "free" accounts.',
    'No child sexual abuse material, and nothing that sexualises minors. That is reported to the authorities, not just deleted.',
    'No content you do not have the right to share — pirated films, albums, books and software are removed when they are reported.',
    'Every download needs a signed-in OpenVibe account, and every share carries the name of the person who made it.',
];
const REPORT_NOTE = 'Every share page has a Report form. Three different people reporting a share — or one report of illegal content — suspends it at once and puts it in front of OpenVibe staff.';

function createPageRoutes(ctx) {
    const { config, s, drive, uploads, media } = ctx;
    const r = asyncRouter();
    // The pages' forms are web forms (no JavaScript): urlencoded text, and one multipart file upload whose body the
    // upload route reads itself. The JSON parser is deliberately absent here.
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => Boolean(req.viewer && req.viewer.kind === 'user' && req.viewer.subject);
    const staffViewer = (req) => isStaff(req.viewer);
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const viewerOf = (req) => ({ subject: req.viewer.subject, username: req.viewer.username || null });

    // ── Small pieces ─────────────────────────────────────────
    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;
    const fileSize = (row) => rules.formatBytes(row.size);

    /** The usage bar. A <progress> element: it means what it says without a stylesheet and without JavaScript. */
    const usageBar = (u) => html`<div class="usage">
<progress id="usage" max="${u.bytes_limit}" value="${u.bytes_used}" aria-describedby="usage-text">${Math.round((u.bytes_used / u.bytes_limit) * 100)}%</progress>
<p id="usage-text" class="small muted">${rules.formatBytes(u.bytes_used)} of ${rules.formatBytes(u.bytes_limit)} used · ${u.files} file${u.files === 1 ? '' : 's'} · ${u.uploads_today} of ${u.uploads_per_day} uploads today · ${u.live_shares} of ${u.max_shares} live share links</p></div>`;

    const SHARE_STATE = { live: ['live', 'ok'], expired: ['expired', 'warn'], revoked: ['revoked', 'bad'], suspended: ['suspended — with staff', 'bad'] };
    const shareBadge = (state) => badge(SHARE_STATE[state] ? SHARE_STATE[state][0] : state, SHARE_STATE[state] ? SHARE_STATE[state][1] : '');

    const fileRow = (row) => html`<li class="file">
<span class="file-main"><a class="file-name" href="/files/${row.id}">${row.name}</a>
<span class="file-meta small muted">${fileSize(row)} · ${row.content_type} · added ${time(row.created_at)}</span></span>
<a class="sc-btn" href="/files/${row.id}/download">Download</a></li>`;

    /** The same per-caller budget the API applies, given an HTML face. */
    const budgeted = (name) => {
        const limit = ctx.limits.budget(name);
        return (req, res, next) => {
            let settled = false;
            const refusal = (body) => {
                let p = null;
                try { p = JSON.parse(String(body)); } catch { p = null; }
                if (p && p.retry_after_seconds) res.set('Retry-After', String(p.retry_after_seconds));
                return page(req, res, {
                    title: 'Too many requests',
                    crumbs: [{ label: 'Home', href: '/' }, { label: 'Too many requests' }],
                    body: html`<h1>Too many requests just now</h1>
${notice(p && p.detail ? p.detail : 'You are over the limit for this.', 'warn')}
<p class="muted">Wait a moment and send it again — nothing was lost. <a href="/files">Your files</a> are still there.</p>`,
                }, 429);
            };
            limit(req, {
                statusCode: 0,
                setHeader: () => {}, getHeader: () => undefined, removeHeader: () => {},
                end: (body) => { if (!settled) { settled = true; refusal(body); } },
            }, (err) => {
                if (settled) return undefined;
                settled = true;
                return err ? next(err) : next();
            });
            return undefined;
        };
    };

    /** A signed-in page write must come from this site, exactly as in the API. */
    function sameSite(req, res, back) {
        if (sameOrigin(req, config.baseUrl)) return true;
        page(req, res, {
            title: 'Not from this site',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Not from this site' }],
            body: html`<h1>That came from somewhere else</h1><p class="muted">A signed-in page that changes something has to come from openvibe.download itself. <a href="${back}">Go back</a> and try again.</p>`,
        }, 403);
        return false;
    }

    /**
     * The signed-in gate. Every page that shows a file answers this to a guest — there is no anonymous anything.
     * `back` is where sign-in returns to: a fixed page, or the current URL for a share link.
     */
    const mustSignIn = (back, why = 'A file belongs to your OpenVibe account, so you can share it, download it or delete it later.') =>
        (req, res, next) => (signedIn(req) ? next()
            : page(req, res, {
                title: 'Sign in',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Sign in' }],
                body: html`<h1>Sign in first</h1>${signInPrompt(why, back === 'here' ? req.originalUrl : back)}`,
            }, 401));

    // ── Home ─────────────────────────────────────────────────
    r.get('/', (req, res) => {
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'OpenVibe.Download',
            accent: TAGLINE,
            lede: 'A private drive for your files, with share links you control. Uploads and every file page need a signed-in OpenVibe account — there is no anonymous upload and no anonymous download here.',
            actions: signedIn(req)
                ? [{ label: 'Your files', href: '/files', primary: true }, { label: 'The safety rules', href: '/safety' }]
                : [{ label: 'Sign in with OpenVibe', href: '/auth/login?next=%2Ffiles', primary: true }, { label: 'The safety rules', href: '/safety' }],
            note: 'The bytes live in OpenVibe.Media. This service holds the names, the folders and the share links.',
        });
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: homeJsonLd(config),
            styles: [showcase.STYLESHEET],
            body: html`${raw(hero)}
${raw(showcase.features({
                title: 'What you get',
                lede: 'A drive, not a locker: everything here is yours, and everything you hand out can be taken back.',
                items: [
                    { icon: 'ov:upload', title: 'Your own drive', text: 'Folders and files, private to you. 2 GB stored and 512 MB in one file, from this service\'s own configuration.' },
                    { icon: 'ov:link', title: 'Share links', text: 'One link per file or folder, expiring in an hour to seven days, revocable at any moment, with its downloads counted.' },
                    { icon: 'ov:account', title: 'Signed in, always', text: 'Nobody opens a share link without an OpenVibe account. No app tokens, no anonymous anything — a shared link still needs a person.' },
                    { icon: 'ov:shield', title: 'Reports that act', text: REPORT_NOTE },
                    { icon: 'ov:tools', title: 'A drive with an API', text: 'The same actions over /api/v1: list, upload, share, revoke, and see your usage.' },
                    { icon: 'ov:db', title: 'Bytes in OpenVibe.Media', text: 'Files are objects in the network\'s own media service; deleting one here asks Media to delete it too.' },
                ],
            }))}
${raw(showcase.steps({
                title: 'How it works',
                lede: 'Four steps, and the last one is the point.',
                items: [
                    { title: 'Sign in', text: 'OpenVibe.Network signs you in. Your session stays in an httpOnly cookie on this site.' },
                    { title: 'Upload', text: 'One request for a file under the single-request limit; a big file goes up in parts with a progress meter. Both need a signed-in person.' },
                    { title: 'Share', text: 'Make a link that expires in an hour, a day or a week, and optionally name the OpenVibe usernames allowed to open it.' },
                    { title: 'Take it back', text: 'Revoke a link and it stops working at once. Delete a file and its shares go with it, and Media is asked to drop the bytes.' },
                ],
            }))}
${raw(showcase.cta({ title: 'Before you upload', text: 'Read the rules: what is not allowed, how reports work, and who to write to.', actions: [{ label: 'The safety rules', href: '/safety' }, { label: 'What shipped', href: '/updates' }] }))}`,
        });
    });

    // ── The drive ────────────────────────────────────────────
    /** The folder a request is looking at, if it is the person's own. */
    async function folderOf(req) {
        const want = String(req.query.folder || req.body.folder || '');
        if (!want) return { folder: null, path: [] };
        const folder = await drive.ownFolder(requesterOf(req), want);
        if (!folder) return { folder: null, path: [] };
        return { folder, path: await drive.folderPath(requesterOf(req), folder.id) };
    }

    const uploadForm = (folder) => html`<form class="card upload" method="post" action="/files/upload" enctype="multipart/form-data" data-upload>
<h2>Upload a file</h2>
${folder ? html`<input type="hidden" name="folder" value="${folder.id}">` : ''}
<div class="field"><label for="file">File</label><input id="file" name="file" type="file" required></div>
<div class="field"><label for="name">Name (optional)</label><input id="name" name="name" type="text" maxlength="${rules.NAME_MAX}" placeholder="leave empty to keep the file's own name"></div>
<p><button class="sc-btn sc-primary" type="submit">Upload</button></p>
<p class="small muted">Up to ${rules.formatBytes(config.quotas.maxFileBytes)} per file and ${rules.formatBytes(config.quotas.bytes)} in total, ${config.quotas.uploadsPerDay} uploads a day. Files over ${rules.formatBytes(config.singleUploadBytes)} go up in parts, which needs JavaScript; without it, the browser sends one request and files that size are refused.</p>
<progress id="upload-progress" max="100" value="0" hidden></progress>
<p id="upload-status" class="small muted" role="status"></p>
</form>`;

    r.get('/files', mustSignIn('/files'), async (req, res) => {
        const owner = requesterOf(req);
        const { folder, path } = await folderOf(req);
        const folders = (await drive.listFolders(owner)).filter((f) => (f.parent_id || null) === (folder ? folder.id : null));
        const files = await drive.listFiles(owner, { folderId: folder ? folder.id : null, limit: 200 });
        const shares = (await drive.listShares(owner)).filter((sh) => drive.stateOf(sh, s.iso()) === 'live');
        const crumbs = [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }];
        for (const f of path) crumbs.push({ label: f.name, href: `/files?folder=${encodeURIComponent(f.id)}` });
        return page(req, res, {
            title: folder ? `${folder.name} · Your files` : 'Your files',
            crumbs,
            // The one page script: it turns the upload form into a chunked, resumable, progressive upload. The
            // form itself works without it.
            scripts: ['js/upload.js'],
            body: html`<h1>${folder ? folder.name : 'Your files'}</h1>
${usageBar(await drive.usage(owner))}
${folder ? html`<p><a href="/files">← All files</a></p>` : ''}
<section aria-labelledby="h-upload">${uploadForm(folder)}</section>
<section aria-labelledby="h-folders"><h2 id="h-folders">Folders</h2>
${folders.length ? html`<ul class="file-list">${folders.map((f) => html`<li class="file"><span class="file-main"><a class="file-name" href="/files?folder=${encodeURIComponent(f.id)}">${f.name}</a><span class="file-meta small muted">folder</span></span></li>`)}</ul>` : html`<p class="muted">No folders here yet.</p>`}
<form class="inline" method="post" action="/folders">
${folder ? html`<input type="hidden" name="parent" value="${folder.id}">` : ''}
<label for="new-folder">New folder</label> <input id="new-folder" name="name" type="text" maxlength="${rules.FOLDER_NAME_MAX}" required> <button class="sc-btn" type="submit">Create</button>
</form></section>
<section aria-labelledby="h-files"><h2 id="h-files">Files</h2>
${files.length ? html`<ul class="file-list">${files.map(fileRow)}</ul>` : html`<p class="muted">No files here yet.</p>`}</section>
<section aria-labelledby="h-shares"><h2 id="h-shares">Live share links</h2>
${shares.length ? html`<ul class="file-list">${shares.map((sh) => html`<li class="file"><span class="file-main"><a class="file-name" href="/s/${sh.slug}">/s/${sh.slug}</a>
<span class="file-meta small muted">expires ${time(sh.expires_at)} · ${Number(sh.downloads)} download${Number(sh.downloads) === 1 ? '' : 's'}${sh.allowed_subjects ? ' · limited to named people' : ''}</span></span>
<form class="inline" method="post" action="/shares/${sh.slug}/revoke"><button class="sc-btn" type="submit">Revoke</button></form></li>`)}</ul>` : html`<p class="muted">No live share links. Open a file to make one.</p>`}</section>`,
        });
    });

    r.get('/files/:id', mustSignIn('/files'), async (req, res) => {
        const owner = requesterOf(req);
        const row = await drive.ownFile(owner, String(req.params.id || ''));
        if (!row) return notFoundFile(req, res);
        const shares = (await drive.listShares(owner)).filter((sh) => sh.file_id === row.id);
        return page(req, res, {
            title: row.name,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }, { label: row.name }],
            body: html`<h1>${row.name}</h1>
${table(['Size', 'Type', 'SHA-256', 'Added'], [[fileSize(row), row.content_type, row.sha256 || '—', time(row.created_at)]])}
<p><a class="sc-btn sc-primary" href="/files/${row.id}/download">Download</a></p>
<section aria-labelledby="h-share"><h2 id="h-share">Make a share link</h2>
<form method="post" action="/files/${row.id}/share">
<div class="field"><label for="hours">Expires in</label><select id="hours" name="hours">${rules.EXPIRY_CHOICES.map((c) => html`<option value="${c.hours}"${c.hours === rules.EXPIRY_DEFAULT_HOURS ? raw(' selected') : ''}>${c.label}</option>`)}</select></div>
<div class="field"><label for="usernames">Limited to OpenVibe usernames (optional)</label><input id="usernames" name="usernames" type="text" maxlength="300" placeholder="kim, sam"><p class="small muted">Leave empty for any signed-in person with the link. Everyone who opens it still has to be signed in.</p></div>
<p><button class="sc-btn sc-primary" type="submit">Create the link</button></p>
</form>
${shares.length ? html`<h3>Its links</h3><ul class="file-list">${shares.map((sh) => html`<li class="file">${shareBadge(drive.stateOf(sh, s.iso()))} <a href="/s/${sh.slug}">/s/${sh.slug}</a> <span class="small muted">expires ${time(sh.expires_at)} · ${Number(sh.downloads)} downloads</span></li>`)}</ul>` : ''}
</section>
<section aria-labelledby="h-delete"><h2 id="h-delete">Delete</h2>
<p class="muted">Deleting removes every share link to this file at once, and asks OpenVibe.Media to delete the object.</p>
<form method="post" action="/files/${row.id}/delete"><button class="sc-btn" type="submit">Delete this file</button></form></section>`,
        });
    });

    function notFoundFile(req, res) {
        return page(req, res, {
            title: 'No such file',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }],
            body: html`<h1>No such file</h1><p class="muted">It is not yours, or it is gone. <a href="/files">Your files</a>.</p>`,
        }, 404);
    }

    // ── Uploads from the page ────────────────────────────────
    /** Where a no-JavaScript upload is spooled before it goes to Media, part by part. */
    const spoolDir = () => config.tmpDir || path.join(os.tmpdir(), 'mediahub-uploads');

    r.post('/files/upload', mustSignIn('/files'), budgeted('media-hub.upload.start'), async (req, res) => {
        if (!sameSite(req, res, '/files')) return undefined;
        const type = String(req.get('content-type') || '');
        const boundary = /^multipart\/form-data/i.test(type) ? boundaryOf(type) : null;
        if (!boundary) return uploadFailed(req, res, 'That was not a file upload. Pick a file and send the form again.');

        // A request bigger than this is refused before it is read: nginx caps it too (deploy/nginx).
        const declared = Number(req.get('content-length'));
        if (Number.isFinite(declared) && declared > config.singleUploadBytes + 64 * 1024) {
            return uploadFailed(req, res, `A form upload is at most ${rules.formatBytes(config.singleUploadBytes)}. Larger files go up in parts — the upload form on this page does that with JavaScript on.`);
        }

        fs.mkdirSync(spoolDir(), { recursive: true });
        const tmp = path.join(spoolDir(), `form-${crypto.randomBytes(8).toString('hex')}`);
        const got = await readFormData(req, { boundary, filePath: tmp, maxBytes: config.singleUploadBytes + 64 * 1024 });
        try {
            if (got.error === 'too_large') return uploadFailed(req, res, `A form upload is at most ${rules.formatBytes(config.singleUploadBytes)}. Larger files go up in parts — the upload form on this page does that with JavaScript on.`);
            if (got.error) return uploadFailed(req, res, 'The upload did not arrive complete. Try again.');
            if (!got.file || !got.file.size) return uploadFailed(req, res, 'No file was in that form, or it was empty.');

            const owner = requesterOf(req);
            const { folder } = await folderOf(req);
            const out = await uploads.uploadSpooled({
                owner, file: got.file.path, size: got.file.size,
                name: rules.fileName(got.fields.name || got.file.filename, got.file.filename),
                contentType: rules.normalizeType(got.file.contentType) || 'application/octet-stream',
                folderId: folder ? folder.id : null,
            });
            // A refusal by our own rules is shown as it came; a Media outage is one sentence, not Media's own words.
            if (!out.ok) return uploadFailed(req, res, String(out.code).startsWith('media.')
                ? `OpenVibe.Media could not store that just now (${out.code}). Nothing was kept here — try again in a moment.`
                : (out.detail || 'The upload could not be stored.'));
            return res.redirect(303, `/files/${out.file.id}`);
        } finally {
            fs.promises.unlink(got.file && got.file.path ? got.file.path : tmp).catch(() => {});
        }
    });

    const uploadFailed = (req, res, detail) => page(req, res, {
        title: 'The upload did not go through',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }],
        body: html`<h1>That upload did not go through</h1>${notice(detail, 'warn')}<p><a class="sc-btn" href="/files">Back to your files</a></p>`,
    }, 422);

    r.post('/files/:id/delete', mustSignIn('/files'), async (req, res) => {
        if (!sameSite(req, res, '/files')) return undefined;
        const row = await drive.ownFile(requesterOf(req), String(req.params.id || ''));
        if (!row) return notFoundFile(req, res);
        await drive.deleteFile(requesterOf(req), row.id);
        return res.redirect(303, '/files');
    });

    r.post('/files/:id/share', mustSignIn('/files'), budgeted('media-hub.share.create'), async (req, res) => {
        if (!sameSite(req, res, '/files')) return undefined;
        const owner = requesterOf(req);
        const row = await drive.ownFile(owner, String(req.params.id || ''));
        if (!row) return notFoundFile(req, res);
        const names = String((req.body || {}).usernames || '').split(/[\s,]+/).filter(Boolean).slice(0, 50);
        const out = await drive.createShare(owner, {
            fileId: row.id, hours: (req.body || {}).hours, names, ownerUsername: req.viewer.username || null,
        });
        if (!out.ok) {
            return page(req, res, {
                title: 'The link was not made',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }, { label: row.name, href: `/files/${row.id}` }],
                body: html`<h1>The link was not made</h1>${notice(out.detail, 'warn')}<p><a class="sc-btn" href="/files/${row.id}">Back to the file</a></p>`,
            }, out.code === 'share.limit' ? 429 : 422);
        }
        return page(req, res, {
            title: 'Share link made',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }, { label: row.name, href: `/files/${row.id}` }],
            body: html`<h1>Share link made</h1>
<p>The link is <a href="/s/${out.share.slug}"><code>/s/${out.share.slug}</code></a> — it expires ${time(out.share.expires_at)}${out.share.allowed_subjects ? ' and only the people you named can open it' : ''}.</p>

<p class="muted">Everyone who opens it has to be signed in to OpenVibe before they can download.</p>
<p><a class="sc-btn sc-primary" href="/s/${out.share.slug}">Open the share page</a> <a class="sc-btn" href="/files/${row.id}">Back to the file</a></p>`,
        });
    });

    r.post('/folders', mustSignIn('/files'), budgeted('media-hub.folder.create'), async (req, res) => {
        if (!sameSite(req, res, '/files')) return undefined;
        const { folder } = await folderOf(req);
        const out = await drive.createFolder(requesterOf(req), { name: (req.body || {}).name, parentId: folder ? folder.id : null });
        if (out.error) {
            return page(req, res, {
                title: 'The folder was not made',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Your files', href: '/files' }],
                body: html`<h1>The folder was not made</h1>${notice(out.detail, 'warn')}<p><a class="sc-btn" href="/files">Back to your files</a></p>`,
            }, out.error === 'folder.exists' ? 409 : 422);
        }
        return res.redirect(303, folder ? `/files?folder=${encodeURIComponent(folder.id)}` : '/files');
    });

    r.post('/shares/:slug/revoke', mustSignIn('/files'), async (req, res) => {
        if (!sameSite(req, res, '/files')) return undefined;
        await drive.revokeShare(requesterOf(req), String(req.params.slug || ''));
        return res.redirect(303, '/files');
    });

    // ── Downloading ──────────────────────────────────────────
    /**
     * Send a file's bytes. MediaHub is in the path on purpose: the browser-facing headers are the security policy
     * (always an attachment, never a sniffed type, the real type only for a short safe list), and this is the only
     * place that can guarantee them whatever Media does with the object. Media's own signed URL is used underneath,
     * on the configured Media host, and is never handed to a browser.
     */
    async function sendFile(req, res, row) {
        const got = await media.bytes(row.object_id, { range: req.get('range') });
        if (!got.ok) {
            // Media's own words for "there is nothing to send": the file is gone, not our problem to hide.
            const gone = got.status === 404 || got.status === 410 || got.code === 'media.object.deleted' || got.code === 'media.object.not_found';
            const status = gone ? 410 : 502;
            return res.status(status).type('text/plain').send(status === 410
                ? 'The bytes of that file are gone from OpenVibe.Media.'
                : 'OpenVibe.Media did not answer. Try again in a moment.');
        }
        const upstream = got.res;
        res.status(upstream.status === 206 ? 206 : 200);
        res.set({
            // A safe type keeps its own Content-Type so the downloaded file opens as what it is; everything else
            // (HTML, SVG, XML, scripts) is an opaque blob. It is an attachment either way: nothing here is ever
            // rendered in a page, on this site or anywhere else.
            'Content-Type': rules.safeContentType(row.content_type) || 'application/octet-stream',
            'Content-Disposition': rules.contentDisposition(row.name),
            'X-Content-Type-Options': 'nosniff',
            // Even a browser that ignored the attachment would run nothing from these bytes.
            'Content-Security-Policy': "default-src 'none'; sandbox",
            'X-Robots-Tag': 'noindex',
            'Cache-Control': 'private, no-store',
        });
        for (const [from, to] of [['content-length', 'Content-Length'], ['content-range', 'Content-Range'], ['accept-ranges', 'Accept-Ranges']]) {
            const v = upstream.headers.get(from);
            if (v) res.set(to, v);
        }
        if (!upstream.body) return res.end();
        try {
            await pipeline(Readable.fromWeb(upstream.body), res);
        } catch {
            res.destroy();      // the reader went away mid-download: nothing to say to anybody
        }
        return undefined;
    }

    r.get('/files/:id/download', mustSignIn('/files'), async (req, res) => {
        const row = await drive.ownFile(requesterOf(req), String(req.params.id || ''));
        if (!row) return notFoundFile(req, res);
        return sendFile(req, res, row);
    });

    // ── Share links ──────────────────────────────────────────
    /**
     * The share a visitor is looking at, and whether they may open it. A share page needs a signed-in person like
     * every other file page: the link is what makes the file reachable at all, and being signed in is what makes
     * the download attributable.
     */
    async function openShare(req, res) {
        const viewer = viewerOf(req);
        const slug = String(req.params.slug || '');
        const share = rules.isSlug(slug) ? await drive.shareBySlug(slug) : null;
        const state = drive.stateOf(share, s.iso());
        if (!share || state === 'revoked' || state === 'expired') {
            page(req, res, {
                title: 'Link not available',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link' }],
                body: html`<h1>That link is not available</h1><p class="muted">It has expired or been revoked by the person who made it. <a href="/">OpenVibe.Download</a>.</p>`,
            }, 404);
            return null;
        }
        if (state === 'suspended') {
            page(req, res, {
                title: 'Link suspended',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link' }],
                body: html`<h1>This link is suspended</h1>${notice('People reported it, so it is with OpenVibe staff until they have looked at it. Nothing can be downloaded from it in the meantime.', 'warn')}<p class="muted"><a href="/safety">What happens when you report something</a>.</p>`,
            }, 403);
            return null;
        }
        if (!drive.allowedFor(share, viewer)) {
            page(req, res, {
                title: 'Not shared with you',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link' }],
                body: html`<h1>This link is not for you</h1><p class="muted">It was shared with particular OpenVibe accounts. You are signed in as <strong>${req.viewer.username || 'you'}</strong>. <a href="/files">Your files</a>.</p>`,
            }, 403);
            return null;
        }
        return share;
    }

    r.get('/s/:slug', mustSignIn('here', 'A share link still needs an OpenVibe account: uploads, downloads and reports here all belong to a signed-in person.'), async (req, res) => {
        const share = await openShare(req, res);
        if (!share) return undefined;
        const mine = share.owner === requesterOf(req);
        if (share.file_id) {
            const file = await fileById(share);
            if (!file) return shareGone(req, res, share);
            return page(req, res, {
                title: `${file.name} · shared by ${share.owner_username || 'an OpenVibe member'}`,
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Shared file' }],
                body: html`<h1>${file.name}</h1>
${notice(`Shared with you by ${share.owner_username ? `@${share.owner_username}` : 'an OpenVibe member'}.`, 'info')}
${table(['Size', 'Type', 'Expires', 'Downloads'], [[fileSize(file), file.content_type, time(share.expires_at), String(Number(share.downloads) || 0)]])}
<p><a class="sc-btn sc-primary" href="/s/${share.slug}/download">Download</a></p>
${mine ? '' : reportForm(share)}
<p class="small muted">${REPORT_NOTE}</p>`,
            });
        }
        const files = await drive.listFiles(share.owner, { folderId: share.folder_id, limit: 200 });
        const folder = await drive.ownFolder(share.owner, share.folder_id);
        return page(req, res, {
            title: `${folder ? folder.name : 'A folder'} · shared by ${share.owner_username || 'an OpenVibe member'}`,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Shared folder' }],
            body: html`<h1>${folder ? folder.name : 'A folder'}</h1>
${notice(`Shared with you by ${share.owner_username ? `@${share.owner_username}` : 'an OpenVibe member'}.`, 'info')}
<p class="small muted">${files.length} file${files.length === 1 ? '' : 's'} · expires ${time(share.expires_at)}</p>
${files.length ? html`<ul class="file-list">${files.map((f) => html`<li class="file"><span class="file-main"><span class="file-name">${f.name}</span><span class="file-meta small muted">${fileSize(f)} · ${f.content_type}</span></span><a class="sc-btn" href="/s/${share.slug}/f/${f.id}/download">Download</a></li>`)}</ul>` : html`<p class="muted">The folder is empty.</p>`}
${mine ? '' : reportForm(share)}`,
        });
    });

    /** The file row behind a file share, by its id — the owner's row, or null once it was deleted. */
    async function fileById(share) {
        const row = share.file_id ? await ctx.store.getFile(s, share.file_id) : null;
        return row && !row.deleted_at ? row : null;
    }

    const shareGone = (req, res, share) => page(req, res, {
        title: 'The file is gone',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${share.slug}` }],
        body: html`<h1>The file behind this link is gone</h1><p class="muted">Its owner deleted it. <a href="/">OpenVibe.Download</a>.</p>`,
    }, 410);

    const reportForm = (share) => html`<section class="card" aria-labelledby="h-report"><h2 id="h-report">Report this</h2>
<form method="post" action="/s/${share.slug}/report">
<div class="field"><label for="reason">Why?</label><select id="reason" name="reason" required>${rules.REASONS.map((x) => html`<option value="${x}">${rules.REASON_TEXT[x]}</option>`)}</select></div>
<div class="field"><label for="note">Anything to add? (optional)</label><textarea id="note" name="note" maxlength="500" rows="3"></textarea></div>
<p><button class="sc-btn" type="submit">Report it</button></p>
</form>
<p class="small muted">${REPORT_NOTE}</p></section>`;

    r.get('/s/:slug/download', mustSignIn('here', 'A share link still needs an OpenVibe account before anything can be downloaded.'), async (req, res) => {
        const share = await openShare(req, res);
        if (!share) return undefined;
        const file = share.file_id ? await fileById(share) : null;
        if (!file) return shareGone(req, res, share);
        await ctx.store.countDownload(s, share.slug);
        return sendFile(req, res, file);
    });

    r.get('/s/:slug/f/:fileId/download', mustSignIn('here', 'A share link still needs an OpenVibe account before anything can be downloaded.'), async (req, res) => {
        const share = await openShare(req, res);
        if (!share) return undefined;
        if (!share.folder_id) return res.redirect(303, `/s/${share.slug}`);   // a file share has no files inside it
        const files = await drive.listFiles(share.owner, { folderId: share.folder_id, limit: 1000 });
        const file = files.find((f) => f.id === String(req.params.fileId || ''));
        if (!file) {
            return page(req, res, {
                title: 'No such file',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Shared folder', href: `/s/${share.slug}` }],
                body: html`<h1>No such file in this share</h1><p class="muted"><a href="/s/${share.slug}">The share page</a>.</p>`,
            }, 404);
        }
        await ctx.store.countDownload(s, share.slug);
        return sendFile(req, res, file);
    });

    r.post('/s/:slug/report', mustSignIn('here'), async (req, res) => {
        if (!sameSite(req, res, '/s')) return undefined;
        const slug = String(req.params.slug || '');
        const reason = String((req.body || {}).reason || '');
        const note = rules.cleanText((req.body || {}).note, 500);
        if (!rules.REASONS.includes(reason)) {
            return page(req, res, {
                title: 'That report was not sent',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${slug}` }],
                body: html`<h1>That report was not sent</h1>${notice('Pick one of the reasons on the list.', 'warn')}<p><a class="sc-btn" href="/s/${slug}">Back to the share</a></p>`,
            }, 422);
        }
        const out = await drive.report(slug, { reporter: requesterOf(req), reason, note });
        if (out.error === 'share.own') {
            return page(req, res, {
                title: 'That is your share',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${slug}` }],
                body: html`<h1>That is your own link</h1><p class="muted">You cannot report your own share. <a href="/files">Your files</a>.</p>`,
            }, 403);
        }
        if (out.error === 'report.duplicate') {
            return page(req, res, {
                title: 'Already reported',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${slug}` }],
                body: html`<h1>You have already reported this</h1><p class="muted">One report per person per link. Thank you. <a href="/s/${slug}">Back to the share</a>.</p>`,
            }, 409);
        }
        if (out.error === 'share.revoked') {
            return page(req, res, {
                title: 'The link was taken down',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${slug}` }],
                body: html`<h1>That link was already taken down</h1><p class="muted">Its owner revoked it. <a href="/">OpenVibe.Download</a>.</p>`,
            }, 409);
        }
        if (out.error) {
            return page(req, res, {
                title: 'No such share',
                crumbs: [{ label: 'Home', href: '/' }, { label: 'Share link', href: `/s/${slug}` }],
                body: html`<h1>No such share</h1><p class="muted"><a href="/">OpenVibe.Download</a>.</p>`,
            }, 404);
        }
        return page(req, res, {
            title: 'Report received',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report received' }],
            body: html`<h1>Thank you — that is with us</h1>
${notice(out.suspended
                ? 'This share is suspended now and OpenVibe staff have been given it. Nothing can be downloaded from it until they have looked.'
                : `That was report ${out.count}. A share is suspended at ${rules.SUSPEND_AT_REPORTS} distinct reports, or at once for illegal content.`, 'warn')}
<p class="muted">Read <a href="/safety">how reports work</a>, or write to <a href="mailto:${ABUSE_EMAIL}">${ABUSE_EMAIL}</a>.</p>`,
        });
    });

    // ── The report queue (staff) ─────────────────────────────
    r.get('/staff', async (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Report queue',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>The report queue</h1>${signInPrompt('The queue is for OpenVibe staff.', '/staff')}`,
        }, 401);
        if (!staffViewer(req)) return page(req, res, {
            title: 'Staff only',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>Staff only</h1><p class="muted">The report queue is for OpenVibe staff — a Network role of <code>admin</code> or <code>global_mod</code>. Yours is <code>${req.viewer.role || 'user'}</code>. <a href="/files">Your files</a>.</p>`,
        }, 403);
        const rows = await ctx.store.staffQueue(s, { limit: 100 });
        const counts = await ctx.store.staffCounts(s);
        const items = [];
        for (const row of rows) items.push({ row, reports: await drive.reportsFor(row.slug), file: row.file_id ? await fileById(row) : null });
        return page(req, res, {
            title: 'Report queue',
            description: 'Share links people reported, for OpenVibe staff to restore or remove.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
            body: html`<h1>The report queue</h1>
<p class="sc-lede">${counts.reported} share link${counts.reported === 1 ? '' : 's'} reported, ${counts.suspended} suspended, ${counts.revoked} revoked by their owner. A share is suspended at ${rules.SUSPEND_AT_REPORTS} distinct reports, or at once for illegal content.</p>
${items.length ? items.map((it) => html`<section class="card staff-item">
<h2><a href="/s/${it.row.slug}">/s/${it.row.slug}</a> ${shareBadge(drive.stateOf(it.row, s.iso()))}</h2>
<p class="small muted">Shared by <code>${it.row.owner_username ? `@${it.row.owner_username}` : it.row.owner}</code> · expires ${time(it.row.expires_at)} · ${Number(it.row.downloads)} downloads · ${Number(it.row.report_count)} report${Number(it.row.report_count) === 1 ? '' : 's'}</p>
${it.file ? html`<p><b>${it.file.name}</b> · ${rules.formatBytes(it.file.size)} · ${it.file.content_type} · object <code>${it.file.object_id}</code></p>` : html`<p class="muted">The file behind this link is gone, or it is a folder share.</p>`}
<ul class="report-list small">${it.reports.map((rp) => html`<li><b>${rp.reason}</b> · <code>${rp.reporter}</code> · ${time(rp.created_at)}${rp.note ? html` — ${rp.note}` : ''}</li>`)}</ul>
<form class="inline" method="post" action="/staff/${it.row.slug}/restore"><button class="sc-btn" type="submit">Restore it</button></form>
<form class="inline" method="post" action="/staff/${it.row.slug}/remove"><button class="sc-btn" type="submit">Remove the file</button></form>
</section>`) : html`<p class="muted">Nothing has been reported.</p>`}`,
        });
    });

    r.post('/staff/:slug/restore', async (req, res) => {
        if (!signedIn(req) || !staffViewer(req)) return staffOnly(req, res);
        if (!sameSite(req, res, '/staff')) return undefined;
        await drive.restoreShare(String(req.params.slug || ''));
        return res.redirect(303, '/staff');
    });

    r.post('/staff/:slug/remove', async (req, res) => {
        if (!signedIn(req) || !staffViewer(req)) return staffOnly(req, res);
        if (!sameSite(req, res, '/staff')) return undefined;
        await drive.removeShared(String(req.params.slug || ''));
        return res.redirect(303, '/staff');
    });

    const staffOnly = (req, res) => page(req, res, {
        title: 'Staff only',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Report queue' }],
        body: html`<h1>Staff only</h1><p class="muted">Restoring or removing a share is for OpenVibe staff — a Network role of <code>admin</code> or <code>global_mod</code>.</p>`,
    }, signedIn(req) ? 403 : 401);

    // ── Safety ───────────────────────────────────────────────
    r.get('/safety', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: 'Safety rules',
        description: 'What OpenVibe.Download allows, what it does not, how reports work, and who to write to.',
        crumbs: [{ label: 'Home', href: '/' }, { label: 'Safety' }],
        styles: [showcase.STYLESHEET],
        body: html`<h1>The rules of OpenVibe.Download</h1>
${notice('This is a private drive with share links. It is not a place to hide, and nothing here is anonymous.', 'warn')}
<section class="sc-sec" aria-labelledby="h-rules"><h2 id="h-rules">What is not allowed</h2>
<ul class="prose">${SAFETY_RULES.map((x) => html`<li>${x}</li>`)}</ul></section>
<section class="sc-sec" aria-labelledby="h-uploads"><h2 id="h-uploads">Who can do what</h2>
<ul class="prose">
<li><b>Every upload needs a signed-in OpenVibe account.</b> There is no anonymous upload and no app or service token that can post a file here.</li>
<li><b>Every file is private to the person who uploaded it.</b> Nobody else sees it in a list, and nobody else can download it.</li>
<li><b>Every download needs a signed-in OpenVibe account too.</b> A share link does not open a file on its own: the person opening it must be signed in, and the share page says who shared it.</li>
<li><b>A share can be limited to named OpenVibe usernames</b>, expire in an hour to seven days, and be revoked at any moment — after which it stops working at once.</li>
<li><b>Downloads never happen in a page.</b> A file is always sent as an attachment with a no-sniff header, and a type that is not on a short safe list is sent as an opaque blob. Uploaded HTML and SVG are never rendered.</li>
</ul></section>
<section class="sc-sec" aria-labelledby="h-reports"><h2 id="h-reports">How reports work</h2>
<p class="sc-prose">${REPORT_NOTE} A report says why: malware, illegal content, copyright, or something else, with room to explain in up to 500 characters. You can report a share once, and reporting your own share is refused.</p>
<p class="sc-prose">Reports are read by OpenVibe staff — a Network role of <code>admin</code> or <code>global_mod</code>. Staff can restore a share (the report stays on the record) or remove the file, which deletes it for its owner as well and asks OpenVibe.Media to delete the object.</p></section>
<section class="sc-sec" aria-labelledby="h-limits"><h2 id="h-limits">The limits</h2>
<ul class="prose">
<li>${rules.formatBytes(config.quotas.bytes)} stored per person.</li>
<li>${rules.formatBytes(config.quotas.maxFileBytes)} in one file.</li>
<li>${config.quotas.uploadsPerDay} uploads a day, from midnight UTC.</li>
<li>${config.quotas.maxShares} live share links at a time.</li>
<li>A share expires in ${rules.EXPIRY_MIN_HOURS} hour${rules.EXPIRY_MIN_HOURS === 1 ? '' : 's'} to ${rules.EXPIRY_MAX_HOURS / 24} days, seven by default.</li>
</ul>
<p class="sc-prose">The bytes live in <a href="https://openvibe.media">OpenVibe.Media</a>, the network's own media service. Deleting a file here asks Media to delete its object; Media keeps its own retention period before the bytes are purged.</p></section>
<section class="sc-sec" aria-labelledby="h-contact"><h2 id="h-contact">Report abuse, or a copyright problem</h2>
<p class="sc-prose">Write to <a href="mailto:${ABUSE_EMAIL}">${ABUSE_EMAIL}</a> for anything that needs a human now — illegal content, malware, a threat. Copyright complaints go to <a href="mailto:${DMCA_EMAIL}">${DMCA_EMAIL}</a>; say which link, and what right you hold. The Report form on any share page is faster for everything else.</p></section>
<section class="sc-sec" aria-labelledby="h-account"><h2 id="h-account">Your account, your data</h2>
<p class="sc-prose">Your files, folders, share links, reports and upload counts are yours to export or delete with your OpenVibe account (ADR-033): deleting the account deletes them here and asks OpenVibe.Media to delete the objects. Read more in the <a href="https://openvibe.network">account settings on OpenVibe.Network</a>.</p></section>`,
    }));

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'media-hub', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes, SAFETY_RULES, ABUSE_EMAIL };
