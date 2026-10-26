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

    // The player takes the picture's shape once it plays (2026-10-26): an upright recording opens into an upright box,
    // and one that turns mid-stream (OpenVibe.Media cuts it in one part per shape) eases from one to the other. A size
    // change that keeps the ratio within 3% (a lowered resolution) moves nothing. Until playback starts the box stays
    // 16:9, so loading the page shifts nothing below it; video.css caps the height so the title stays on screen.
    function followShape(video) {
        let current = 0;
        let on = false;
        const update = function () {
            const w = video.videoWidth;
            const h = video.videoHeight;
            if (!on || !(w > 0 && h > 0)) return;
            const r = Math.min(3.2, Math.max(0.4, w / h));
            if (current && Math.abs(Math.log(r / current)) < 0.03) return;
            current = r;
            video.style.setProperty('--ovv-ar', r.toFixed(4));
        };
        video.addEventListener('playing', function () { on = true; update(); });
        video.addEventListener('resize', update);
    }

    function attachSource(video) {
        const hlsUrl = video.getAttribute('data-ovv-hls');
        const fileUrl = video.getAttribute('src');
        if (!hlsUrl || !fileUrl) return Promise.resolve('file');
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS (Safari, iOS, and Chrome since it plays HLS itself) fetches segments as the element does. A
            // segment Media moved to its object store redirects to another origin, which plays only in CORS mode: in
            // no-cors mode Chrome could not parse it (VOD 5925 stopped at 1:23:35 on 2026-10-23). Media and its store
            // both answer CORS. A private recording's signed playlist (?exp&sig) is served without CORS on purpose, so it
            // stays in no-cors mode. If the playlist still fails, the file plays from the same position, without CORS
            // (its edge sends no CORS header), once.
            if (!/[?&]sig=/.test(hlsUrl)) video.crossOrigin = 'anonymous';
            video.src = hlsUrl;
            video.addEventListener('error', function fallback() {
                video.removeEventListener('error', fallback);
                const at = video.currentTime || 0;
                video.removeAttribute('crossorigin');
                video.src = fileUrl;
                if (at > 0) seek(video, at);
            });
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

    function clockOf(seconds) {
        const n = Math.max(0, Math.floor(seconds || 0));
        const h = Math.floor(n / 3600);
        const m = Math.floor((n % 3600) / 60);
        const s = String(n % 60).padStart(2, '0');
        return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
    }

    // The Download menu (a <details>, usable without this): it closes on a click elsewhere, on Escape, on its close
    // button and once a format is chosen, and stays inside the window; on a phone it is a sheet over a dimmed page.
    // "Copy for a YouTube description" copies the chapters' text where the browser lets a page write the clipboard.
    function downloads() {
        const menus = Array.prototype.slice.call(document.querySelectorAll('[data-ovv-dl]'));
        const close = function (dl, focus) {
            if (!dl.open) return;
            dl.open = false;
            if (focus) dl.querySelector('summary').focus();
        };
        menus.forEach(function (dl) {
            dl.classList.add('ovv-dl--js');
            const menu = dl.querySelector('.ovv-dl-menu');
            dl.addEventListener('toggle', function () {
                menu.style.left = '';
                dl.classList.remove('ovv-dl--up');
                if (!dl.open || window.innerWidth <= 600) return;
                const over = menu.getBoundingClientRect().right - (document.documentElement.clientWidth - 12);
                if (over > 0) menu.style.left = -over + 'px';
                // Below the button when it fits; above when only that fits; else below, scrolled into view.
                const button = dl.querySelector('summary').getBoundingClientRect();
                const tall = menu.getBoundingClientRect().height + 16;
                const below = window.innerHeight - button.bottom;
                if (tall > below && button.top > below && button.top >= tall) dl.classList.add('ovv-dl--up');
                else if (tall > below) menu.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
            const x = dl.querySelector('[data-ovv-dl-close]');
            if (x) x.addEventListener('click', function () { close(dl, true); });
            menu.addEventListener('click', function (e) {
                if (e.target.closest('a[download]')) setTimeout(function () { close(dl, false); }, 150);
            });
        });
        if (menus.length) {
            document.addEventListener('click', function (e) {
                menus.forEach(function (dl) {
                    if (dl.open && !dl.querySelector('.ovv-dl-menu').contains(e.target) && !dl.querySelector('summary').contains(e.target)) close(dl, false);
                });
            });
            document.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') menus.forEach(function (dl) { close(dl, true); });
            });
        }
        if (!navigator.clipboard || !window.fetch) return;
        document.querySelectorAll('[data-ovv-copy]').forEach(function (b) {
            const wrap = b.closest('[data-ovv-copy-wrap]');
            if (wrap) wrap.hidden = false;
            const label = b.innerHTML;
            const say = function (text) {
                b.textContent = text;
                setTimeout(function () { b.innerHTML = label; }, 2000);
            };
            b.addEventListener('click', function () {
                fetch(b.getAttribute('data-ovv-copy'), { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
                    .then(function (text) { return navigator.clipboard.writeText(text); })
                    .then(function () { say('Copied'); }, function () { say('Could not copy: use the TXT download'); });
            });
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        // A clip still being cut: look again in a few seconds (the server answers once it is ready).
        const cutting = document.querySelector('[data-ovv-reload]');
        if (cutting) {
            const wait = Math.max(3, Number(cutting.getAttribute('data-ovv-reload')) || 8) * 1000;
            setTimeout(function () { window.location.replace(window.location.pathname); }, wait);
        }

        downloads();

        const video = document.querySelector('video[data-ovv-video]');
        if (!video) return;

        // "Make a clip": with the player here, mark the start and end at the current time.
        const now = document.querySelector('[data-ovv-clip-now]');
        if (now) {
            now.hidden = false;
            now.querySelectorAll('[data-ovv-clip-mark]').forEach(function (b) {
                b.addEventListener('click', function () {
                    const which = b.getAttribute('data-ovv-clip-mark');
                    const input = document.querySelector(which === 'start' ? '[data-ovv-clip-start]' : '[data-ovv-clip-end]');
                    if (input) input.value = clockOf(video.currentTime);
                    if (which === 'start') {
                        const end = document.querySelector('[data-ovv-clip-end]');
                        if (end && !end.value) end.value = clockOf(video.currentTime + 30);
                    }
                });
            });
        }

        followShape(video);
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
