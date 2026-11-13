'use strict';

const express = require('express');
const ID = /^\d{1,15}$/;   // the comment service's ids (the thread renderer carries the same rule)

const ACCEPT = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain']);
const MAX_FILE = 16 * 1024 * 1024;
const multipart = express.raw({ type: 'multipart/form-data', limit: '65mb' });

async function readCommentForm(req) {
    if (!Buffer.isBuffer(req.body)) throw new Error('The comment form was not received');
    const request = new Request('http://localhost/comment', { method: 'POST', headers: { 'content-type': req.get('content-type') }, body: req.body });
    const form = await request.formData();
    const message = String(form.get('message') || '').trim();
    const files = form.getAll('files').filter((f) => f && typeof f.arrayBuffer === 'function' && f.size);
    // A picture alone is a comment, as on any social app (the owner, 11-12): words are optional with a file attached.
    if ((!message && !files.length) || message.length > 2000) throw new Error('Write something or attach a picture (up to 2,000 characters)');
    const parent = String(form.get('parent_id') || '');
    if (parent && !ID.test(parent)) throw new Error('That reply target is not valid');
    if (files.length > 4) throw new Error('Attach up to four files');
    for (const file of files) {
        if (file.size > MAX_FILE) throw new Error('A file can be up to 16 MB');
        if (!ACCEPT.has(file.type)) throw new Error('Attach JPEG, PNG, GIF, WebP, PDF or text files');
    }
    return { message, parent_id: parent || null, files };
}

module.exports = { multipart, readCommentForm };
