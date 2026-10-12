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

    document.addEventListener('DOMContentLoaded', function () {
        const video = document.querySelector('video[data-ovv-video]');
        if (!video) return;

        const t = startSeconds();
        if (t != null) seek(video, t);

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
