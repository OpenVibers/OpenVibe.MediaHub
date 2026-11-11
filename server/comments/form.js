'use strict';

const express = require('express');
const { ID } = require('./inline');

const ACCEPT = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const MAX_FILE = 16 * 1024 * 1024;
const multipart = express.raw({ type: 'multipart/form-data', limit: '65mb' });

async function readCommentForm(req) {
    if (!Buffer.isBuffer(req.body)) throw new Error('The comment form was not received');
    const request = new Request('http://localhost/comment', { method: 'POST', headers: { 'content-type': req.get('content-type') }, body: req.body });
    const form = await request.formData();
    const message = String(form.get('message') || '').trim();
    if (!message || message.length > 2000) throw new Error('A comment is 1 to 2,000 characters');
    const parent = String(form.get('parent_id') || '');
    if (parent && !ID.test(parent)) throw new Error('That reply target is not valid');
    const files = form.getAll('files').filter((f) => f && typeof f.arrayBuffer === 'function' && f.size);
    if (files.length > 4) throw new Error('Attach up to four files');
    for (const file of files) {
        if (file.size > MAX_FILE) throw new Error('A file can be up to 16 MB');
        if (!ACCEPT.has(file.type)) throw new Error('Attach JPEG, PNG, GIF, WebP, PDF or text files');
    }
    return { message, parent_id: parent || null, files };
}

module.exports = { multipart, readCommentForm };
