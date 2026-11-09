/* Video's same-origin VOD adapter for the shared picker and progress component. */
(function () {
    'use strict';
    var form = document.querySelector('form[data-video-upload]');
    if (!form || !window.OVUpload) return;
    var kit = window.OVUpload;
    var status = form.querySelector('[role=status]');
    var button = form.querySelector('button[type=submit]');
    var sheet = document.querySelector('[data-upload-rules-sheet]');
    var state = { file: null, upload: null, sent: 0, sending: false, saved: false, complete: null, cancelled: false };
    var meterEl = form.querySelector('[data-ov-upload-progress]');
    var meter = kit.progress(meterEl, { onRetry: function () { if (state.file) send(); } });
    var picker = kit.picker(form.querySelector('[data-ov-upload-picker]'), {
        label: 'Choose a video', accept: 'video/mp4,video/quicktime,video/x-m4v,video/webm,video/x-matroska,.mp4,.mov,.m4v,.webm,.mkv',
        onFile: choose, onRemove: remove
    });
    form.querySelector('[data-upload-rules]').addEventListener('click', function () { sheet.showModal(); });
    function say(message) { status.textContent = message; }
    function titleOf(file) { return file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 120) || 'Untitled video'; }
    function request(path, options) {
        return fetch(path, options).then(function (response) {
            if (response.ok) return response.status === 204 ? null : response.json();
            return response.json().catch(function () { return {}; }).then(function (body) {
                var error = new Error(body.detail || 'The upload could not continue (' + response.status + ').');
                error.status = response.status; throw error;
            });
        });
    }
    function json(method, path, body) { return request(path, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    function db() {
        return new Promise(function (resolve, reject) {
            if (!window.indexedDB) { resolve(null); return; }
            var open = indexedDB.open('ov-video-upload', 1);
            open.onupgradeneeded = function () { open.result.createObjectStore('pending'); };
            open.onsuccess = function () { resolve(open.result); };
            open.onerror = function () { reject(open.error); };
        });
    }
    function stored(value) {
        return db().then(function (database) {
            if (!database) return;
            return new Promise(function (resolve, reject) {
                var tx = database.transaction('pending', 'readwrite');
                if (value) tx.objectStore('pending').put(value, 'video'); else tx.objectStore('pending').delete('video');
                tx.oncomplete = resolve; tx.onerror = function () { reject(tx.error); };
            });
        }).catch(function () { /* Storage quota can refuse a large File; this tab still works. */ });
    }
    function load() {
        return db().then(function (database) {
            if (!database) return null;
            return new Promise(function (resolve, reject) {
                var tx = database.transaction('pending', 'readonly');
                var get = tx.objectStore('pending').get('video');
                get.onsuccess = function () { resolve(get.result); };
                get.onerror = function () { reject(get.error); };
            });
        }).catch(function () { return null; });
    }
    function snapshot() { return stored(state.file && state.upload ? { file: state.file, upload: state.upload, title: form.elements.title.value, description: form.elements.description.value, visibility: form.elements.visibility.value, saved: state.saved } : null); }
    function choose(file) {
        if (state.file) { say('Remove this video before choosing another.'); return; }
        state.file = file; state.cancelled = false; state.saved = false; state.complete = null;
        meterEl.hidden = false;
        form.elements.title.value = titleOf(file);
        button.disabled = false;
        meter.update({ state: 'waiting', done: 0, total: file.size, message: '' });
        start();
    }
    function remove(file) {
        if (file !== state.file) return;
        state.cancelled = true;
        var id = state.upload && state.upload.id;
        state.file = null; state.upload = null; state.sent = 0; state.sending = false; state.complete = null;
        meterEl.hidden = true;
        button.disabled = true; meter.update({ state: 'waiting', done: 0, total: 0, message: '' }); say('Video removed.');
        stored(null);
        if (id) request('/api/v1/videos/' + encodeURIComponent(id), { method: 'DELETE' }).catch(function () {});
    }
    function start() {
        var file = state.file;
        if (!file) return;
        say('Starting your upload…');
        json('POST', '/api/v1/videos', { title: form.elements.title.value, description: '', visibility: 'private', size: file.size, content_type: file.type || '', name: file.name }).then(function (out) {
            if (state.cancelled || file !== state.file) { request('/api/v1/videos/' + out.upload.id, { method: 'DELETE' }).catch(function () {}); return; }
            state.upload = out.upload; snapshot(); send();
        }).catch(fail);
    }
    function putPart(id, number, blob, onProgress) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', '/api/v1/videos/' + encodeURIComponent(id) + '/parts/' + number);
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.upload.onprogress = function (event) { if (event.lengthComputable) onProgress(event.loaded); };
            xhr.onload = function () {
                if (xhr.status >= 200 && xhr.status < 300) { resolve(); return; }
                var detail = '';
                try { detail = JSON.parse(xhr.responseText).detail || ''; } catch (_) { /* network response */ }
                var err = new Error(detail || 'Part ' + number + ' was refused (' + xhr.status + ').');
                err.status = xhr.status; reject(err);
            };
            xhr.onerror = function () { reject(new Error('The connection dropped. Your video will resume.')); };
            xhr.send(blob);
        });
    }
    function waitOnline() {
        if (navigator.onLine !== false) return Promise.resolve();
        meter.update({ state: 'paused' }); say('Paused: no connection');
        return new Promise(function (resolve) { window.addEventListener('online', resolve, { once: true }); });
    }
    function retryPart(id, number, blob, base, attempt) {
        return waitOnline().then(function () {
            meter.update({ state: 'sending' });
            return putPart(id, number, blob, function (loaded) { meter.update({ done: base + loaded, total: state.file.size, state: 'sending' }); });
        }).catch(function (error) {
            if (state.cancelled || error.status && error.status < 500 || attempt >= 5) throw error;
            return new Promise(function (resolve) { setTimeout(resolve, Math.min(12000, 600 * Math.pow(2, attempt))); }).then(function () {
                return retryPart(id, number, blob, base, attempt + 1);
            });
        });
    }
    function send() {
        if (state.sending || !state.file || !state.upload) return;
        state.sending = true;
        var file = state.file, upload = state.upload;
        var id = encodeURIComponent(upload.id);
        request('/api/v1/videos/' + id + '/status').then(function (out) {
            if (out.upload.size !== file.size) throw new Error('Choose the same file to resume this upload.');
            if (out.upload.status !== 'uploading') { state.complete = { video: { url: '/u/' + id } }; return; }
            var n = out.upload.parts_received + 1;
            state.sent = out.upload.parts_received * upload.part_size;
            meter.update({ state: 'sending', done: state.sent, total: file.size });
            function next() {
                if (state.cancelled) return;
                if (n > upload.parts_expected) return;
                var base = (n - 1) * upload.part_size;
                var blob = file.slice(base, Math.min(base + upload.part_size, file.size));
                return retryPart(id, n, blob, base, 0).then(function () {
                    state.sent = base + blob.size; n++;
                    meter.update({ state: 'sending', done: state.sent, total: file.size });
                    snapshot(); return next();
                });
            }
            return next().then(function () {
                if (state.cancelled) return;
                meter.update({ state: 'processing', done: file.size, total: file.size });
                return request('/api/v1/videos/' + id + '/complete', { method: 'POST' }).then(function (done) { state.complete = done; });
            });
        }).then(function () {
            state.sending = false;
            if (state.cancelled || !state.complete) return;
            if (state.saved) stored(null); else snapshot();
            meter.update({ state: 'done', done: file.size, total: file.size, message: 'Your video is processing.' });
            say(state.saved ? 'Opening your video…' : 'Upload complete. Save details to continue.');
            if (state.saved) window.location.assign(state.complete.video.url);
        }).catch(function (err) { state.sending = false; fail(err); });
    }
    function fail(err) { meter.update({ state: 'failed', message: err && err.message || 'The upload did not go through.' }); say('Upload paused. You can retry.'); }
    form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!state.upload || !state.file) { say('Choose a video first.'); return; }
        button.disabled = true;
        json('PATCH', '/api/v1/videos/' + encodeURIComponent(state.upload.id), { title: form.elements.title.value, description: form.elements.description.value, visibility: form.elements.visibility.value }).then(function () {
            state.saved = true; snapshot(); button.disabled = false; button.textContent = 'Details saved';
            if (state.complete) { stored(null); window.location.assign(state.complete.video.url); }
            else say('Details saved. Your video is still uploading.');
        }).catch(function (err) { button.disabled = false; say(err.message); });
    });
    window.addEventListener('beforeunload', function (event) { if (state.sending) { event.preventDefault(); event.returnValue = ''; } });
    load().then(function (pending) {
        if (state.file || !pending || !pending.file || !pending.upload) return;
        state.file = pending.file; state.upload = pending.upload; state.saved = !!pending.saved;
        form.elements.title.value = pending.title; form.elements.description.value = pending.description;
        form.elements.visibility.value = pending.visibility;
        button.disabled = false;
        picker.add([pending.file]);
        say('Resuming your video…'); send();
    });
})();
