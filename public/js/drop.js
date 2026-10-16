/* OpenVibe.Download — uploading without an account (server/drive/drops.js), on the home page when drops are on.
 *
 * The file goes up in the drive's parts: POST /api/v1/drops (name, size, type) answers a session and a token, each
 * part is a PUT with the header X-Drop-Token, then POST …/complete answers the public link and a delete link shown
 * once. Nothing here is put in a URL but the session id; the token travels in a header.
 */
(function () {
    'use strict';
    var box = document.querySelector('[data-drop]');
    if (!box || !window.fetch) return;
    var input = box.querySelector('input[type=file]');
    var button = box.querySelector('[data-drop-send]');
    var bar = box.querySelector('progress');
    var status = box.querySelector('[role=status]');
    if (!input || !button) return;

    function say(text) { status.textContent = text; }
    function progress(done, total) { bar.hidden = false; bar.max = total; bar.value = done; }
    function problem(res) {
        return res.json().then(function (j) { return (j && (j.detail || j.code)) || ('HTTP ' + res.status); }, function () { return 'HTTP ' + res.status; });
    }
    function linkLine(label, href) {
        var p = document.createElement('p');
        p.appendChild(document.createTextNode(label + ' '));
        var a = document.createElement('a');
        a.href = href;
        a.textContent = href;
        p.appendChild(a);
        return p;
    }

    button.addEventListener('click', function () {
        var file = input.files && input.files[0];
        if (!file) { say('Choose a file first.'); return; }
        button.disabled = true;
        say('Starting…');
        var token = null;
        var upload = null;
        fetch('/api/v1/drops', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: file.name, size: file.size, content_type: file.type || 'application/octet-stream' }),
        }).then(function (res) {
            if (!res.ok) return problem(res).then(function (m) { throw new Error(m); });
            return res.json();
        }).then(function (j) {
            token = j.token;
            upload = j.upload;
            var n = 0;
            function next() {
                n += 1;
                if (n > upload.parts_expected) return Promise.resolve();
                var start = (n - 1) * upload.part_size;
                var part = file.slice(start, Math.min(file.size, start + upload.part_size));
                return fetch('/api/v1/drops/' + encodeURIComponent(upload.id) + '/parts/' + n, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/octet-stream', 'X-Drop-Token': token },
                    body: part,
                }).then(function (res) {
                    if (!res.ok) return problem(res).then(function (m) { throw new Error(m); });
                    progress(Math.min(file.size, start + part.size), file.size);
                    say('Uploading… ' + Math.round((Math.min(file.size, start + part.size) / file.size) * 100) + '%');
                    return next();
                });
            }
            return next();
        }).then(function () {
            say('Finishing…');
            return fetch('/api/v1/drops/' + encodeURIComponent(upload.id) + '/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Drop-Token': token },
                body: '{}',
            });
        }).then(function (res) {
            if (!res.ok) return problem(res).then(function (m) { throw new Error(m); });
            return res.json();
        }).then(function (j) {
            status.textContent = '';
            var done = document.createElement('p');
            done.textContent = 'Uploaded. Anyone with this link can download it:';
            status.appendChild(done);
            status.appendChild(linkLine('Link:', j.drop.url));
            status.appendChild(linkLine('Delete link (shown once, keep it):', j.delete_url));
            button.disabled = false;
            input.value = '';
        }).catch(function (err) {
            say('The upload did not finish: ' + (err && err.message ? err.message : err));
            button.disabled = false;
        });
    });
}());
