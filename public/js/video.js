/* OpenVibe.Video — seek helpers for the watch pages (no inline handlers). */
(function () {
    'use strict';

    function startSeconds() {
        const m = /[?&]t=(\d+(?:\.\d+)?)/.exec(window.location.search);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) && n >= 0 ? n : null;
    }

    function seek(video, seconds) {
        if (!video || !Number.isFinite(seconds) || seconds < 0) return;
        const apply = function () { video.currentTime = seconds; };
        if (video.readyState >= 1) apply();
        else video.addEventListener('loadedmetadata', apply, { once: true });
    }

    function setT(seconds) {
        const u = new URL(window.location.href);
        u.searchParams.set('t', String(seconds));
        window.history.replaceState(null, '', u.pathname + '?' + u.searchParams.toString());
    }

    // Media's segment timeline (HLS) when the recording has one: native where the browser plays HLS (Safari, iOS),
    // otherwise hls.js (self-hosted, loaded only then). The file in src stays the fallback: a playlist that fails
    // falls back to it once, at the same position.
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            const s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = reject;
            document.head.appendChild(s);
        });
    }

    function attachSource(video) {
        const hlsUrl = video.getAttribute('data-ovv-hls');
        const fileUrl = video.getAttribute('src');
        if (!hlsUrl || !fileUrl) return Promise.resolve('file');
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = hlsUrl;
            return Promise.resolve('hls');
        }
        if (!window.MediaSource) return Promise.resolve('file');
        return loadScript(video.getAttribute('data-ovv-hls-lib')).then(function () {
            if (typeof window.Hls === 'undefined' || !window.Hls.isSupported()) return 'file';
            const hls = new window.Hls({ enableWorker: true, backBufferLength: 60 });
            let failed = false;
            hls.on(window.Hls.Events.ERROR, function (_event, data) {
                if (!data || !data.fatal || failed) return;
                failed = true;
                const at = video.currentTime || 0;
                hls.destroy();
                video.src = fileUrl;
                if (at > 0) seek(video, at);
            });
            hls.loadSource(hlsUrl);
            hls.attachMedia(video);
            return 'hls';
        }, function () { return 'file'; });
    }

    document.addEventListener('DOMContentLoaded', function () {
        const video = document.querySelector('video[data-ovv-video]');
        if (!video) return;

        const t = startSeconds();
        attachSource(video).then(function (source) {
            video.setAttribute('data-ovv-source', source);
            if (t != null) seek(video, t);
        });

        // A view counts on OpenVibe.Live once playback starts, from this browser (so the viewer's own address is the
        // one counted, as on Live's own pages). The beacon carries no body and no answer is read.
        const viewUrl = video.getAttribute('data-ovv-view');
        if (viewUrl && navigator.sendBeacon) {
            video.addEventListener('playing', function () {
                try { navigator.sendBeacon(viewUrl); } catch (e) { /* a view that is not counted is not an error */ }
            }, { once: true });
        }

        // A playlist's watch page (?list=…) carries the next item on the player; move to it when this ends.
        const nextUrl = video.getAttribute('data-ovv-next');
        if (nextUrl) {
            video.addEventListener('ended', function () {
                window.location.href = nextUrl;
            });
        }

        document.querySelectorAll('[data-ovv-seek]').forEach(function (el) {
            el.addEventListener('click', function () {
                seek(video, Number(el.getAttribute('data-ovv-seek')));
            });
        });

        const chapters = Array.prototype.slice.call(document.querySelectorAll('[data-ovv-chapter]'));
        chapters.forEach(function (el) {
            el.addEventListener('click', function (e) {
                e.preventDefault();
                const n = Number(el.getAttribute('data-ovv-chapter'));
                seek(video, n);
                setT(n);
                const p = video.play();
                if (p && p.catch) p.catch(function () { /* autoplay refused: the seek still happened */ });
            });
        });

        // The chapter being played is marked as playback moves (aria-current for screen readers too).
        let current = null;
        video.addEventListener('timeupdate', function () {
            let at = null;
            for (let i = 0; i < chapters.length; i++) {
                if (Number(chapters[i].getAttribute('data-ovv-chapter')) <= video.currentTime + 0.25) at = chapters[i];
                else break;
            }
            if (at === current) return;
            if (current) { current.classList.remove('is-current'); current.removeAttribute('aria-current'); }
            current = at;
            if (current) { current.classList.add('is-current'); current.setAttribute('aria-current', 'true'); }
        });
        // Chat replay: mark rows up to the current time as past and dim the ones still ahead, keeping
        // the newest past row in view inside the panel's own scroll box (never the page).
        const chatBody = document.querySelector('[data-ovv-chat]');
        if (chatBody) {
            const chatRows = Array.prototype.slice.call(chatBody.querySelectorAll('[data-ovv-at]'));
            let userScrollUntil = 0;
            let lastAutoScroll = 0;
            chatBody.addEventListener('scroll', function () {
                if (Date.now() - lastAutoScroll > 250) userScrollUntil = Date.now() + 5000;
            });
            video.addEventListener('timeupdate', function () {
                const t = video.currentTime;
                let newest = null;
                for (let i = 0; i < chatRows.length; i++) {
                    const row = chatRows[i];
                    if (Number(row.getAttribute('data-ovv-at')) <= t + 0.25) {
                        row.classList.add('is-past');
                        row.classList.remove('is-ahead');
                        newest = row;
                    } else {
                        row.classList.remove('is-past');
                        row.classList.add('is-ahead');
                    }
                }
                if (!newest || Date.now() < userScrollUntil) return;
                lastAutoScroll = Date.now();
                const pr = chatBody.getBoundingClientRect();
                const rr = newest.getBoundingClientRect();
                const top = rr.top - pr.top + chatBody.scrollTop;
                const bottom = top + rr.height;
                if (top < chatBody.scrollTop) chatBody.scrollTop = top;
                else if (bottom > chatBody.scrollTop + chatBody.clientHeight) chatBody.scrollTop = bottom - chatBody.clientHeight;
            });
        }
    });
})();
