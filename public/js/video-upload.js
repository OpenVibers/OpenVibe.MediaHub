/* OpenVibe.Video — /upload: sends the chosen video in 8 MB parts (POST /api/v1/videos, one PUT per part in order, then
 * complete), so a big file uploads in one go and the person watches the progress. A failed part is tried again three
 * times before the upload stops. Every request is same-origin: the session cookie and Sec-Fetch-Site are the browser's.
 * Nothing about the file but its size, type and name (to tell MOV from MP4) is sent before its bytes. */
(function () {
    'use strict';
    var form = document.querySelector('form[data-video-upload]');
    if (!form || !window.fetch) return;
    var file = form.querySelector('input[type=file]');
    var bar = form.querySelector('progress');
    var status = form.querySelector('[role=status]');
    var button = form.querySelector('button[type=submit]');

    function say(t) { if (status) status.textContent = t; }
    function busy(on) { button.disabled = on; Array.prototype.forEach.call(form.elements, function (el) { if (el !== button) el.disabled = on; }); }
    function request(url, options) {
        return fetch(url, options).then(function (res) {
            if (res.ok) return res.json().catch(function () { return null; });
            return res.json().then(function (p) { throw new Error((p && p.detail) || ('The upload was refused (' + res.status + ').')); },
                function () { throw new Error('The upload was refused (' + res.status + ').'); });
        });
    }
    function withRetry(fn, tries) {
        return fn().catch(function (err) {
            if (tries <= 1 || /refused \((4\d\d)\)|Send part|already finished/.test(err.message)) throw err;
            return new Promise(function (r) { setTimeout(r, 1500); }).then(function () { return withRetry(fn, tries - 1); });
        });
    }

    form.addEventListener('submit', function (event) {
        event.preventDefault();
        var f = file.files && file.files[0];
        if (!f) { say('Choose a video first.'); return; }
        var title = form.elements.title.value;
        var meta = { title: title, description: form.elements.description.value, visibility: form.elements.visibility.value, size: f.size, content_type: f.type || '', name: f.name };
        busy(true);
        bar.hidden = false; bar.max = f.size; bar.value = 0;
        say('Starting…');
        var sent = 0;
        var id = null;
        request('/api/v1/videos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) }).then(function (out) {
            var up = out.upload;
            id = up.id;
            var chain = Promise.resolve();
            for (var n = 1; n <= up.parts_expected; n++) {
                chain = chain.then(function (part) {
                    return function () {
                        var start = (part - 1) * up.part_size;
                        var slice = f.slice(start, Math.min(start + up.part_size, f.size));
                        return withRetry(function () {
                            return request('/api/v1/videos/' + up.id + '/parts/' + part, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: slice });
                        }, 3).then(function () {
                            sent += slice.size;
                            bar.value = sent;
                            say('Uploading… ' + Math.round((sent / f.size) * 100) + '%');
                        });
                    };
                }(n));
            }
            return chain;
        }).then(function () {
            say('Finishing…');
            return request('/api/v1/videos/' + id + '/complete', { method: 'POST' });
        }).then(function (done) {
            say('Uploaded. OpenVibe.Media is processing it; opening its page…');
            window.location.assign(done.video.url);
        }).catch(function (err) {
            busy(false);
            say((err && err.message) || 'The upload did not go through.');
        });
    });
})();
