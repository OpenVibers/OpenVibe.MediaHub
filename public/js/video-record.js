/* OpenVibe.Video — /record: record the camera or the screen with MediaRecorder and send it as it records. Every few
 * seconds the recorder hands over a piece, which goes up in order (PUT /api/v1/videos/:id/chunks/:n) to the video
 * started with POST /api/v1/videos/recordings; Stop sends the last piece and completes it. Nothing is ever live, and
 * nothing is kept in the browser beyond the pieces still waiting to go up. */
(function () {
    'use strict';
    var form = document.querySelector('form[data-video-record]');
    if (!form) return;
    var preview = form.querySelector('.ovv-record-preview');
    var clock = form.querySelector('.ovv-record-clock');
    var status = form.querySelector('[role=status]');
    var bPreview = form.querySelector('[data-record-preview]');
    var bStart = form.querySelector('[data-record-start]');
    var bStop = form.querySelector('[data-record-stop]');
    function say(t) { status.textContent = t; }
    if (!window.MediaRecorder || !navigator.mediaDevices || !window.fetch) { say('This browser cannot record video. Upload a file instead.'); bPreview.disabled = true; return; }
    var TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    var mime = TYPES.filter(function (t) { return MediaRecorder.isTypeSupported(t); })[0] || '';
    var stream = null, recorder = null, id = null, n = 0, queue = Promise.resolve(), failed = null, started = 0, tick = null, sentBytes = 0;
    function source() { var c = form.querySelector('input[name=source]:checked'); return c ? c.value : 'camera'; }
    function stopTracks() { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    function request(url, opts) {
        return fetch(url, opts).then(function (res) {
            if (res.ok) return res.json().catch(function () { return null; });
            return res.json().then(function (p) { throw new Error((p && p.detail) || ('Refused (' + res.status + ').')); }, function () { throw new Error('Refused (' + res.status + ').'); });
        });
    }
    function send(blob) {
        var k = ++n;
        queue = queue.then(function () {
            if (failed) return null;
            var tries = 0;
            var once = function () {
                return request('/api/v1/videos/' + id + '/chunks/' + k, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: blob }).then(function () {
                    sentBytes += blob.size;
                    say('Recording… ' + (sentBytes / 1048576).toFixed(1) + ' MB saved');
                }, function (err) {
                    if (++tries < 3 && !/Refused \(4|already finished|Send piece|at most|pass/.test(err.message)) return new Promise(function (r) { setTimeout(r, 1500); }).then(once);
                    failed = err; throw err;
                });
            };
            return once();
        }).catch(function (err) {
            say('Saving stopped: ' + err.message);
            if (recorder && recorder.state !== 'inactive') recorder.stop();
        });
    }
    function getStream() {
        if (source() === 'screen') {
            return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(function (screen) {
                return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (mic) {
                    mic.getAudioTracks().forEach(function (t) { screen.addTrack(t); });
                    return screen;
                }, function () { return screen; });
            });
        }
        return navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: true });
    }
    bPreview.addEventListener('click', function () {
        stopTracks();
        getStream().then(function (s) {
            stream = s;
            preview.srcObject = s; preview.hidden = false; preview.play().catch(function () {});
            bStart.disabled = false;
            bPreview.textContent = source() === 'screen' ? 'Choose another screen' : 'Restart the camera';
            say('Ready. Press Start recording.');
        }, function () { say(source() === 'screen' ? 'Screen sharing was not allowed.' : 'The camera or microphone was not allowed.'); });
    });
    form.addEventListener('change', function (e) { if (e.target.name === 'source') { bPreview.textContent = e.target.value === 'screen' ? 'Choose the screen' : 'Turn on the camera'; } });
    bStart.addEventListener('click', function () {
        if (!stream) return;
        bStart.disabled = true; bPreview.disabled = true;
        say('Starting…');
        request('/api/v1/videos/recordings', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: form.elements.title.value, visibility: form.elements.visibility.value, content_type: (mime || 'video/webm').split(';')[0] }) })
            .then(function (out) {
                id = out.upload.id;
                recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2500000 } : { videoBitsPerSecond: 2500000 });
                recorder.ondataavailable = function (e) { if (e.data && e.data.size) send(e.data); };
                recorder.onstop = function () {
                    stopTracks(); clearInterval(tick); clock.hidden = true;
                    queue.then(function () {
                        if (failed && n <= 1) throw failed;
                        say('Saving…');
                        return request('/api/v1/videos/' + id + '/complete', { method: 'POST' });
                    }).then(function (done) {
                        say('Saved. OpenVibe.Media is processing it; opening its page…');
                        window.location.assign(done.video.url);
                    }, function (err) { say('The recording could not be saved: ' + err.message); bPreview.disabled = false; });
                };
                // A stream that ends by itself (the screen share stopped) stops the recording too.
                stream.getVideoTracks().forEach(function (t) { t.addEventListener('ended', function () { if (recorder.state !== 'inactive') recorder.stop(); }); });
                recorder.start(4000);
                started = Date.now(); clock.hidden = false;
                tick = setInterval(function () { var s = Math.floor((Date.now() - started) / 1000); clock.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }, 500);
                bStop.disabled = false;
                say('Recording…');
            }, function (err) { say(err.message); bStart.disabled = false; bPreview.disabled = false; });
    });
    bStop.addEventListener('click', function () { bStop.disabled = true; if (recorder && recorder.state !== 'inactive') recorder.stop(); });
    window.addEventListener('beforeunload', function (e) { if (recorder && recorder.state === 'recording') { e.preventDefault(); e.returnValue = ''; } });
})();
