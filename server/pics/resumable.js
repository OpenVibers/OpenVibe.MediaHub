'use strict';
const express = require('express');
const crypto = require('crypto');
const { asyncRouter } = require('../http/router');
const images = require('./store');
function resumable(ctx, { person, problem, whoOf }) {
    const r = asyncRouter(); const { s, pics, config, limits } = ctx;
    const wire = (u) => ({ id: u.id, size: u.size, offset: u.offset_bytes, expires_at: u.expires_at, image_id: u.image_id });
    r.use(person);
    r.post('/', limits.budget('pics.image.upload'), express.json({ limit: '8kb' }), async (req, res) => {
        const b = req.body || {};
        if (!Number.isInteger(b.size) || b.size < 1 || b.size > config.pics.maxImageBytes || !/^image\/(jpeg|png|webp|gif|avif)$/.test(b.content_type)) return problem(req, res, 422, 'pics.upload_invalid', 'Choose a supported image within the upload limit.');
        const result = await s.tx(async () => {
            // A per-owner advisory lock bounds simultaneous unfinished uploads too.
            await s.db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [whoOf(req).requester]);
            await s.db.query('DELETE FROM pics_uploads WHERE expires_at < $1', [s.iso()]);
            const count = Number(await s.db.value('SELECT count(*) FROM pics_uploads WHERE owner = $1 AND image_id IS NULL', [whoOf(req).requester]));
            if (count >= 4) return null;
            return s.db.maybe(`INSERT INTO pics_uploads (id, owner, size, content_type, name, title, expires_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, ['pup_' + crypto.randomBytes(18).toString('hex'), whoOf(req).requester, b.size, b.content_type, String(b.name || 'picture').slice(0, 200), String(b.title || '').slice(0, 120), new Date(s.now() + 86400000).toISOString()]);
        });
        if (!result) return problem(req, res, 429, 'pics.upload_limit', 'Finish or cancel an upload before starting another.');
        return res.status(201).json(wire(result));
    });
    async function own(req, lock = false) {
        return s.db.maybe(`SELECT * FROM pics_uploads WHERE id = $1 AND owner = $2 AND expires_at > $3 ${lock ? 'FOR UPDATE' : ''}`, [req.params.id, whoOf(req).requester, s.iso()]);
    }
    r.get('/:id', async (req, res) => { const u = await own(req); return u ? res.json(wire(u)) : problem(req, res, 404, 'pics.upload_not_found', 'No such upload.'); });
    r.patch('/:id', limits.budget('pics.image.write'), express.raw({ type: () => true, limit: '1mb' }), async (req, res) => s.tx(async () => {
        const u = await own(req, true);
        if (!u) return problem(req, res, 404, 'pics.upload_not_found', 'No such upload.');
        const offset = Number(req.get('upload-offset'));
        if (!req.get('upload-offset') || !Number.isInteger(offset) || offset !== u.offset_bytes || u.image_id) return problem(req, res, 409, 'pics.upload_offset', 'Read the upload status and resume at its offset.');
        if (!Buffer.isBuffer(req.body) || !req.body.length || offset + req.body.length > u.size) return problem(req, res, 422, 'pics.upload_size', 'The chunk must fit the declared upload size.');
        await s.db.query('INSERT INTO pics_upload_chunks (upload_id, offset_bytes, bytes) VALUES ($1,$2,$3)', [u.id, offset, req.body]);
        await s.db.query('UPDATE pics_uploads SET offset_bytes = $2 WHERE id = $1', [u.id, offset + req.body.length]);
        return res.json(wire({ ...u, offset_bytes: offset + req.body.length }));
    }));
    r.post('/:id/complete', limits.budget('pics.image.upload'), async (req, res) => s.tx(async () => {
        const u = await own(req, true);
        if (!u) return problem(req, res, 404, 'pics.upload_not_found', 'No such upload.');
        if (u.image_id) { const image = await images.imageById(s, u.image_id); return res.json(pics.toWire(image, { owner: true })); }
        if (u.offset_bytes !== u.size) return problem(req, res, 409, 'pics.upload_incomplete', 'Upload all bytes before completing.');
        const chunks = await s.db.many('SELECT bytes FROM pics_upload_chunks WHERE upload_id = $1 ORDER BY offset_bytes', [u.id]);
        const out = await pics.upload(whoOf(req), { buffer: Buffer.concat(chunks.map((x) => Buffer.from(x.bytes))), name: u.name }, { title: u.title });
        if (!out.ok) return problem(req, res, out.status, out.code, out.detail);
        await s.db.query('UPDATE pics_uploads SET image_id = $2 WHERE id = $1', [u.id, out.image.id]);
        await s.db.query('DELETE FROM pics_upload_chunks WHERE upload_id = $1', [u.id]);
        return res.status(201).json(pics.toWire(out.image, { owner: true }));
    }));
    r.delete('/:id', async (req, res) => { await s.db.query('DELETE FROM pics_uploads WHERE id = $1 AND owner = $2', [req.params.id, whoOf(req).requester]); return res.status(204).end(); });
    return r;
}
module.exports = { resumable };
