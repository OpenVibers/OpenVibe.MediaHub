'use strict';
const express = require('express');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sameOrigin } = require('../http/principal');

const AUDIO = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/flac']);
const LICENCES = Object.freeze({
    'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
    'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'CC-BY-SA-4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
    public_domain: 'https://creativecommons.org/publicdomain/mark/1.0/',
});
const text = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const https = (value) => { try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && value.length <= 2048 ? u.href : null; } catch { return null; } };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function validGrant(body) {
    const kind = text(body.source_kind, 30), licence = text(body.licence, 30);
    const title = text(body.title, 160), artist = text(body.artist, 120);
    const source = https(text(body.source_url, 2048));
    const changes = text(body.changes_note, 200) || null;
    if (!title || !artist || (body.rights_confirmed !== 'yes' && body.rights_confirmed !== true)) return null;
    if (kind === 'creator' || kind === 'ai') {
        if (licence !== 'creator_grant') return null;
        return { kind, licence, title, artist, source, changes, licenceUrl: 'https://openvibe.download/radio/licence', aiMade: kind === 'ai' };
    }
    if (kind === 'creative_commons' && ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0'].includes(licence) && source && changes)
        return { kind, licence, title, artist, source, changes, licenceUrl: LICENCES[licence], aiMade: false };
    if (kind === 'public_domain' && licence === 'public_domain' && source)
        return { kind, licence, title, artist, source, changes, licenceUrl: LICENCES[licence], aiMade: false };
    return null;
}

function createRadioRoutes({ s, drive, media, config }) {
    const r = express.Router();
    r.use(express.urlencoded({ extended: false, limit: '12kb' }));
    const owner = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject ? `user:${req.viewer.subject}` : null;
    const row = (id) => /^rad_[0-9A-HJKMNP-TV-Z]{26}$/.test(String(id || '')) ? s.db.maybe(
        `SELECT t.*, f.object_id, f.content_type FROM mh_radio_tracks t JOIN mh_files f ON f.id = t.file_id
         WHERE t.id = $1 AND t.revoked_at IS NULL AND f.deleted_at IS NULL`, [id]) : null;
    const wire = (t) => ({ id: t.id, title: t.title, artist: t.artist, source: t.source_kind, source_url: t.source_url,
        licence: t.licence, licence_url: t.licence_url, changes_note: t.changes_note, ai_made: t.ai_made,
        audio_url: `${config.baseUrl}/api/v1/radio/tracks/${encodeURIComponent(t.id)}/audio` });
    r.get('/api/v1/radio/tracks', async (req, res, next) => {
        try {
            const rows = await s.db.many(`SELECT t.* FROM mh_radio_tracks t JOIN mh_files f ON f.id = t.file_id
                WHERE t.revoked_at IS NULL AND f.deleted_at IS NULL ORDER BY t.published_at DESC LIMIT 100`);
            res.set('Cache-Control', 'public, max-age=30').json({ tracks: rows.map(wire) });
        } catch (e) { next(e); }
    });
    r.get('/api/v1/radio/tracks/:id', async (req, res, next) => {
        try { const t = await row(req.params.id); return t ? res.set('Cache-Control', 'no-store').json({ track: wire(t) }) : res.status(404).json({ code: 'radio.not_found' }); }
        catch (e) { next(e); }
    });
    r.get('/api/v1/radio/tracks/:id/audio', async (req, res, next) => {
        try {
            const t = await row(req.params.id);
            if (!t) return res.status(404).end();
            const got = await media.bytes(t.object_id, { range: req.get('range') });
            if (!got.ok) return res.status(got.status === 404 || got.status === 410 ? 410 : 502).end();
            const up = got.res;
            res.status(up.status === 206 ? 206 : 200).set({ 'Content-Type': t.content_type, 'Accept-Ranges': 'bytes',
                'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
            for (const h of ['content-length', 'content-range']) if (up.headers.get(h)) res.set(h, up.headers.get(h));
            if (!up.body) return res.end();
            await pipeline(Readable.fromWeb(up.body), res);
        } catch (e) { if (!res.headersSent) next(e); else res.destroy(); }
    });
    r.get('/radio/licence', (_req, res) => res.type('html').send('<h1>OpenVibe Radio creator grant</h1><p>By publishing, you grant OpenVibe permission to stream this recording to anyone in a listening party until you unpublish it. You confirm you own or control every right needed, including the composition and recording. You retain ownership.</p>'));
    r.get('/radio/publish', async (req, res, next) => {
        try {
            const who = owner(req);
            if (!who) return res.redirect(303, `/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
            const file = await drive.ownFile(who, String(req.query.file || ''));
            if (!file || !AUDIO.has(file.content_type)) return res.status(404).type('text/plain').send('Choose an audio file from your files.');
            res.set('Cache-Control', 'private, no-store').type('html').send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Publish on OpenVibe Radio</title>
<link rel="stylesheet" href="/css/radio.css">
<main class="radio-page">
<h1>Publish on OpenVibe Radio</h1>
<p>${esc(file.name)}</p>
<p>The recording will be playable by anyone. Only publish music you have the right to share.</p>
<form method="post" action="/radio/publish">
<input type="hidden" name="file" value="${esc(file.id)}">
<p>
<label>Track title <input name="title" required maxlength="160" value="${esc(String(file.name || '').replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_-]+/g, ' ').trim())}">
</label>
</p>
<p>
<label>Artist or creator <input name="artist" required maxlength="120">
</label>
</p>
<p>
<label>Source <select name="source_kind">
<option value="creator">My own music</option>
<option value="creative_commons">Creative Commons</option>
<option value="public_domain">Public domain</option>
<option value="ai">AI-made music</option>
</select>
</label>
</p>
<p>
<label>Licence <select name="licence">
<option value="creator_grant">My grant to stream</option>
<option value="CC0-1.0">CC0 1.0</option>
<option value="CC-BY-4.0">CC BY 4.0</option>
<option value="CC-BY-SA-4.0">CC BY-SA 4.0</option>
<option value="public_domain">Public domain</option>
</select>
</label>
</p>
<p>
<label>Original source URL for CC or public domain music <input name="source_url" type="url" placeholder="https://…">
</label>
</p>
<p>
<label>Changes to the original (for CC music, write “none” if unchanged) <input name="changes_note" maxlength="200">
</label>
</p>
<p>
<label class="radio-check">
<input type="checkbox" name="rights_confirmed" value="yes" required> I confirm the recording and composition can be streamed publicly under these rights, and I can provide the required attribution. Public domain means free of known copyright restrictions worldwide.</label>
</p>
<button type="submit">Publish track</button>
</form>
<p>
<a href="/radio/licence">Read the creator grant</a> · <a href="/files/${encodeURIComponent(file.id)}">Back to file</a>
</p>
</main>`);
        } catch (e) { next(e); }
    });
    r.post('/radio/publish', async (req, res, next) => {
        try {
            const who = owner(req);
            if (!who) return res.status(401).end();
            if (!sameOrigin(req, config.baseUrl)) return res.status(403).end();
            const body = req.body || {};
            const file = await drive.ownFile(who, String(body.file || ''));
            if (!file || !AUDIO.has(file.content_type)) return res.status(404).end();
            const grant = validGrant(body);
            if (!grant) return res.status(422).type('text/plain').send('Choose a permitted licence, give its original source and changes where required, and confirm your rights.');
            const id = s.newId('rad');
            await s.db.query(`INSERT INTO mh_radio_tracks (id, file_id, owner, title, artist, source_kind, source_url, licence, licence_url, changes_note, ai_made)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, file.id, who, grant.title, grant.artist, grant.kind, grant.source, grant.licence, grant.licenceUrl, grant.changes, grant.aiMade]);
            return res.redirect(303, `/radio/tracks/${encodeURIComponent(id)}`);
        } catch (e) { if (e.code === '23505') return res.status(409).type('text/plain').send('This file is already published.'); next(e); }
    });
    r.get('/radio/tracks/:id', async (req, res, next) => {
        try { const t = await row(req.params.id); return t ? res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(t.title)} · OpenVibe Radio</title><link rel="stylesheet" href="/css/radio.css"><main class="radio-page"><h1>${esc(t.title)}</h1><p>${esc(t.artist)}</p><audio controls src="/api/v1/radio/tracks/${encodeURIComponent(t.id)}/audio"></audio><p>Source: ${esc(t.source_kind)}${t.source_url ? ` · <a href="${esc(t.source_url)}">Original source</a>` : ''}</p><p>Licence or status: <a href="${esc(t.licence_url)}">${esc(t.licence === 'public_domain' ? 'Public domain mark' : t.licence === 'creator_grant' ? 'Creator permission to stream' : t.licence)}</a>${t.changes_note ? ` · Changes: ${esc(t.changes_note)}` : ''}${t.ai_made ? ' · AI-made music' : ''}</p><p><a href="https://openvibe.party/new?radio=${encodeURIComponent(t.id)}">Listen together on OpenVibe.Party</a></p>${owner(req) === t.owner ? `<form method="post" action="/radio/tracks/${encodeURIComponent(t.id)}/unpublish"><button type="submit">Unpublish</button></form>` : ''}</main>`) : res.status(404).end(); }
        catch (e) { next(e); }
    });
    r.post('/radio/tracks/:id/unpublish', async (req, res, next) => {
        try {
            const who = owner(req);
            if (!who || !sameOrigin(req, config.baseUrl)) return res.status(403).end();
            await s.db.exec('UPDATE mh_radio_tracks SET revoked_at = now() WHERE id = $1 AND owner = $2 AND revoked_at IS NULL', [req.params.id, who]);
            return res.redirect(303, '/files');
        } catch (e) { next(e); }
    });
    return r;
}

module.exports = { createRadioRoutes, validGrant };
