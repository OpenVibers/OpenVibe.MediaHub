'use strict';

/**
 * Getting a file's bytes into OpenVibe.Media and a row into the drive.
 *
 * Every upload is the same three steps against Media — start a multipart session, send its parts, complete it —
 * because that is the one shape that works for a 1 KB file and a 512 MB one, and because it lets the browser send
 * a big file in pieces. What differs is who sends the bytes:
 *
 *   the browser, in parts   POST /api/v1/files → PUT /api/v1/uploads/:id/parts/:n → POST …/complete
 *                           (the page's script; each part is buffered here and forwarded, never written to disk)
 *   the browser, in one     POST /files/upload   (a plain <input type=file> form, no JavaScript)
 *                           the request body is parsed and spooled to a temp file, then read back part by part
 *
 * A part is at most config.partBytes (8 MB by default) in memory at a time. Nothing is written to the database
 * until Media says the object is ready: an upload that dies halfway leaves a Media object and one mh_uploads row,
 * which is exactly what the resume needs and what the abort (or the expiry sweep) clears.
 */
const fs = require('fs');
const store = require('./store');

/** The exact size of part n (1-based) of a session: every part but the last is part_size. */
const partSizeOf = (upload, n) => (n < upload.parts_expected ? upload.part_size : upload.size - upload.part_size * (upload.parts_expected - 1));

/** Read [start, end) of a file into a Buffer — one part, never the whole object. */
function readSlice(file, start, length) {
    return new Promise((resolve, reject) => {
        const buf = Buffer.alloc(length);
        const fd = fs.openSync(file, 'r');
        fs.read(fd, buf, 0, length, start, (err, read) => {
            fs.closeSync(fd);
            if (err) return reject(err);
            if (read !== length) return reject(new Error(`short read: ${read} of ${length}`));
            resolve(buf);
        });
    });
}

function createUploads({ s, media, config, service, log = console }) {
    const nowIso = () => new Date(s.now()).toISOString();

    /** Media's object is `uploading`; the session is Media's, the row is ours. */
    async function startSession({ owner, name, size, contentType, folderId = null }) {
        const room = await service.uploadAllowed(owner, size);
        if (!room.ok) return room;
        if (folderId && !await service.ownFolder(owner, folderId)) {
            return { ok: false, code: 'folder.not_found', detail: 'That folder does not exist.' };
        }
        const started = await media.init({
            size, contentType, name, ownerSubject: owner, multipart: true, partSize: config.partBytes,
        });
        if (!started.ok) return { ok: false, code: started.code, detail: started.detail };
        const objectId = started.data.id;
        let session = started.data.upload && started.data.upload.multipart;
        if (!session || !session.upload_id) {
            const fresh = await media.multipartStart(objectId, { size, partSize: config.partBytes });
            if (!fresh.ok) {
                await media.remove(objectId);
                return { ok: false, code: fresh.code, detail: fresh.detail };
            }
            session = fresh.data;
        }
        const row = await store.insertUpload(s, {
            id: s.newId('upl'), owner, object_id: objectId, upload_id: session.upload_id,
            name, size, content_type: contentType || 'application/octet-stream', folder_id: folderId || null,
            part_size: session.part_size, parts_expected: session.parts_expected,
            created_at: nowIso(), expires_at: new Date(s.now() + config.uploadTtlSeconds * 1000).toISOString(),
        });
        return { ok: true, upload: publicUpload(row, []) };
    }

    /** The upload as the API and the page's script see it: no Media ids beyond the object, no token. */
    const publicUpload = (row, missing) => ({
        id: row.id, name: row.name, size: row.size, content_type: row.content_type,
        folder_id: row.folder_id, part_size: row.part_size, parts_expected: row.parts_expected,
        expires_at: row.expires_at, missing,
        status: row.file_id ? 'complete' : 'open',
    });

    /** This person's own session, still open. An expired one is abandoned here, so nothing lingers. */
    async function openSession(owner, id) {
        if (!id) return null;
        const row = await store.getUpload(s, String(id));
        if (!row || row.owner !== owner) return null;
        if (row.expires_at <= nowIso()) {
            await media.abortMultipart(row.object_id, row.upload_id);
            await store.dropUpload(s, row.id);
            return null;
        }
        return row;
    }

    async function status(owner, id) {
        const row = await openSession(owner, id);
        if (!row) return { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
        const live = await media.multipartStatus(row.object_id, row.upload_id);
        if (!live.ok) {
            // Media has forgotten the session (purged, or the process restarted with a new one): say so plainly.
            return { ok: false, code: live.code, detail: live.detail };
        }
        const missing = Array.isArray(live.data.missing) ? live.data.missing : [];
        return { ok: true, upload: publicUpload(row, missing) };
    }

    /** One part from the client. Its length is checked here (and again by Media) before anything is stored. */
    async function putPart(owner, id, n, buffer) {
        const row = await openSession(owner, id);
        if (!row) return { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
        const part = Number(n);
        if (!Number.isInteger(part) || part < 1 || part > row.parts_expected) {
            return { ok: false, code: 'upload.bad_part', detail: `Part must be 1 to ${row.parts_expected}.` };
        }
        const want = partSizeOf(row, part);
        if (buffer.length !== want) {
            return { ok: false, code: 'upload.part_size', detail: `Part ${part} must be exactly ${want} bytes; ${buffer.length} arrived.` };
        }
        const sent = await media.putPart(row.object_id, row.upload_id, part, buffer);
        if (!sent.ok) return { ok: false, code: sent.code, detail: sent.detail };
        return { ok: true, part, size: want };
    }

    /**
     * Media assembles the parts and makes the object ready; only then does the file exist here. The size and hash
     * are read back from Media — what it stored is the truth, not what the client claimed.
     */
    async function complete(owner, id) {
        const row = await openSession(owner, id);
        if (!row) return { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
        const done = await media.completeMultipart(row.object_id, row.upload_id);
        if (!done.ok) return { ok: false, code: done.code, detail: done.detail };
        const object = done.data || {};
        const file = await service.recordFile({
            owner, objectId: row.object_id, name: row.name,
            size: Number(object.size_bytes) || row.size, contentType: object.mime_type || row.content_type,
            sha256: object.content_hash || null, folderId: row.folder_id,
        });
        await store.setUploadFile(s, row.id, file.id);
        await store.dropUpload(s, row.id);
        return { ok: true, file };
    }

    async function abort(owner, id) {
        const row = await openSession(owner, id);
        if (!row) return { ok: false, code: 'upload.not_found', detail: 'No such upload.' };
        await media.abortMultipart(row.object_id, row.upload_id);
        await store.dropUpload(s, row.id);
        return { ok: true };
    }

    /**
     * The whole file through the session's parts, read from a spooled file. This is the no-JavaScript path: the
     * browser posted one request, we wrote it to disk, and Media gets it in parts exactly as it would from a script.
     */
    async function uploadSpooled({ owner, file, name, size, contentType, folderId = null }) {
        const started = await startSession({ owner, name, size, contentType, folderId });
        if (!started.ok) return started;
        const row = await store.getUpload(s, started.upload.id);
        try {
            let offset = 0;
            for (let n = 1; n <= row.parts_expected; n++) {
                const want = partSizeOf(row, n);
                const buffer = await readSlice(file, offset, want);
                offset += want;
                const sent = await putPart(owner, row.id, n, buffer);
                if (!sent.ok) return sent;
            }
            return await complete(owner, row.id);
        } catch (err) {
            log.warn('[MediaHub] spooled upload failed:', (err && err.message) || '');
            await abort(owner, row.id);
            return { ok: false, code: 'upload.failed', detail: 'The upload could not be finished. Nothing was kept.' };
        }
    }

    return { startSession, status, putPart, complete, abort, uploadSpooled, partSizeOf, publicUpload };
}

module.exports = { createUploads, partSizeOf, readSlice };
