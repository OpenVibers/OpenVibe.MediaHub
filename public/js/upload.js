/* OpenVibe.MediaHub — the chunked upload, and the only JavaScript on any page.
 *
 * The form it upgrades works without it: submit posts the whole file to POST /files/upload in one request. With
 * this script the file goes up in parts instead (POST /api/v1/files, one PUT per part, then complete), so a file
 * larger than the single-request limit still uploads, a dropped connection can resume, and the person can watch
 * the progress.
 *
 * Every request is same-origin, so the browser sends Sec-Fetch-Site: same-origin by itself — which is exactly what
 * a session-cookie write on this site requires. No token, no key and no file name is ever put in a URL.
 */
(function () {
    'use strict';
    var form = document.querySelector('form[data-upload]');
    if (!form || !window.fetch) return;
    var input = form.querySelector('input[type=file]');
    var nameField = form.querySelector('input[name=name]');
    var folderField = form.querySelector('input[name=folder]');
    var bar = form.querySelector('progress');
    var status = form.querySelector('[role=status]');
    var button = form.querySelector('button[type=submit]');
    if (!input) return;

    function say(text) { if (status) status.textContent = text; }
    function progress(done, total) {
        if (!bar) return;
        bar.hidden = false;
        bar.max = total;
        bar.value = done;
    }
    function problem(res) {
        return res.json().then(function (p) {
            return (p && p.detail) || 'The upload was refused.';
        }, function () { return 'The upload was refused (' + res.status + ').'; });
    }
    function busy(on) {
        if (button) button.disabled = on;
        if (input) input.disabled = on;
    }

    /** One request, answering a promise of its JSON (or rejecting with the problem's detail). */
    function request(url, options) {
        return fetch(url, options).then(function (res) {
            if (res.ok) return res.status === 204 ? null : res.json().catch(function () { return null; });
            return problem(res).then(function (detail) { throw new Error(detail); });
        });
    }

    function upload(file) {
        var sent = 0;
        var uploadId = null;
        busy(true);
        progress(0, file.size);
        say('Starting…');
        return request('/api/v1/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: (nameField && nameField.value) || file.name,
                size: file.size,
                content_type: file.type || 'application/octet-stream',
                folder_id: (folderField && folderField.value) || null,
            }),
        }).then(function (started) {
            var up = started.upload;
            uploadId = up.id;
            // Parts go up one after another: one connection, in order, and the meter moves.
            var chain = Promise.resolve();
            for (var n = 1; n <= up.parts_expected; n++) {
                chain = chain.then(function (part) {
                    return function () {
                        var start = (part - 1) * up.part_size;
                        var slice = file.slice(start, Math.min(start + up.part_size, file.size));
                        return request('/api/v1/uploads/' + up.id + '/parts/' + part, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/octet-stream' },
                            body: slice,
                        }).then(function () {
                            sent += slice.size;
                            progress(sent, file.size);
                            say('Uploading… ' + Math.round((sent / file.size) * 100) + '%');
                        });
                    };
                }(n));
            }
            return chain;
        }).then(function () {
            say('Finishing…');
            return request('/api/v1/uploads/' + uploadId + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        }).then(function (done) {
            say('Uploaded. Opening it…');
            window.location.assign('/files/' + done.file.id);
        }).catch(function (err) {
            busy(false);
            say((err && err.message) || 'The upload did not go through.');
        });
    }

    form.addEventListener('submit', function (event) {
        var file = input.files && input.files[0];
        if (!file) return;                      // no file chosen: let the server answer the empty form
        event.preventDefault();
        upload(file);
    });
})();
