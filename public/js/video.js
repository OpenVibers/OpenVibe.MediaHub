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

    // The page's menus (Download, Save, Clip, More and each panel's corner menu): <details>, usable without this. They
    // close on a click elsewhere, on Escape, on a close button and once a file is chosen; opening one closes the
    // others; each stays inside the window (above its button when only that fits). On a phone the action row's menus
    // are sheets from the bottom over a dimmed page; a panel's corner menu stays a small popover.
    function menus() {
        const all = Array.prototype.slice.call(document.querySelectorAll('[data-ovv-dl], [data-ovv-menu]'));
        if (!all.length) return;
        const panelOf = function (d) { return d.querySelector(':scope > :not(summary)'); };
        const sheet = function (d) { return window.innerWidth <= 600 && !d.classList.contains('ovv-mini'); };
        const close = function (d, focus) {
            if (!d.open) return;
            d.open = false;
            if (focus) d.querySelector('summary').focus();
        };
        all.forEach(function (d) {
            d.classList.add(d.classList.contains('ovv-dl') ? 'ovv-dl--js' : d.classList.contains('ovv-mini') ? 'ovv-mini--js' : 'ovv-pop--js');
            const panel = panelOf(d);
            if (!panel) return;
            d.addEventListener('toggle', function () {
                panel.style.transform = '';
                d.classList.remove('ovv-dl--up', 'ovv-pop--up', 'ovv-mini--up');
                if (!d.open) return;
                all.forEach(function (o) { if (o !== d && !o.contains(d)) close(o, false); });
                if (sheet(d)) return;
                const vw = document.documentElement.clientWidth;
                const r = panel.getBoundingClientRect();
                if (r.right > vw - 12) panel.style.transform = 'translateX(' + Math.round(vw - 12 - r.right) + 'px)';
                else if (r.left < 12) panel.style.transform = 'translateX(' + Math.round(12 - r.left) + 'px)';
                const button = d.querySelector('summary').getBoundingClientRect();
                const tall = r.height + 16;
                const below = window.innerHeight - button.bottom;
                const up = d.classList.contains('ovv-dl') ? 'ovv-dl--up' : d.classList.contains('ovv-mini') ? 'ovv-mini--up' : 'ovv-pop--up';
                if (tall > below && button.top > below && button.top >= tall) d.classList.add(up);
                else if (tall > below) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            });
            const x = d.querySelector('[data-ovv-dl-close]');
            if (x) x.addEventListener('click', function () { close(d, true); });
            panel.addEventListener('click', function (e) {
                if (e.target.closest('a[download], a[href^="#"]')) setTimeout(function () { close(d, false); }, 150);
            });
        });
        document.addEventListener('click', function (e) {
            all.forEach(function (d) {
                const panel = panelOf(d);
                if (d.open && panel && !panel.contains(e.target) && !d.querySelector('summary').contains(e.target)) close(d, false);
            });
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') all.forEach(function (d) { if (d.open) close(d, true); });
        });
    }

    // "Copy for YouTube": the chapters' text on the clipboard, where the browser lets a page write it.
    function copyButtons() {
        if (!navigator.clipboard || !window.fetch) return;
        document.querySelectorAll('[data-ovv-copy]').forEach(function (b) {
            b.hidden = false;
            const wrap = b.closest('[data-ovv-copy-wrap]');
            if (wrap) wrap.hidden = false;
            const label = b.innerHTML;
            const say = function (title, hint) {
                b.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i><span><b></b><small></small></span>';
                b.querySelector('b').textContent = title;
                b.querySelector('small').textContent = hint;
                setTimeout(function () { b.innerHTML = label; }, 2200);
            };
            b.addEventListener('click', function () {
                fetch(b.getAttribute('data-ovv-copy'), { credentials: 'same-origin' })
                    .then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })
                    .then(function (text) { return navigator.clipboard.writeText(text); })
                    .then(function () { say('Copied', 'Paste it into the description'); }, function () { say('Could not copy', 'Use the Text download instead'); });
            });
        });
    }

    // Chat replay, chapters and the transcript as tabs (the server lists them one after another). The tab chosen last
    // opens first on the next page.
    function tabs() {
        document.querySelectorAll('[data-ovv-tabs]').forEach(function (box) {
            const list = box.querySelector('[data-ovv-tablist]');
            if (!list) return;
            const buttons = Array.prototype.slice.call(list.querySelectorAll('[data-ovv-tab]'));
            const panels = Array.prototype.slice.call(box.querySelectorAll('[data-ovv-tp]'));
            const select = function (key, focus) {
                buttons.forEach(function (b) {
                    const on = b.getAttribute('data-ovv-tab') === key;
                    b.setAttribute('aria-selected', on ? 'true' : 'false');
                    b.tabIndex = on ? 0 : -1;
                    if (on && focus) b.focus();
                });
                panels.forEach(function (p) { p.hidden = p.getAttribute('data-ovv-tp') !== key; });
            };
            let saved = null;
            try { saved = window.localStorage.getItem('ovv-tab'); } catch (e) { saved = null; }
            list.hidden = false;
            box.classList.add('ovv-companion--tabs');
            select(buttons.some(function (b) { return b.getAttribute('data-ovv-tab') === saved; }) ? saved : buttons[0].getAttribute('data-ovv-tab'), false);
            buttons.forEach(function (b, i) {
                b.addEventListener('click', function () {
                    const key = b.getAttribute('data-ovv-tab');
                    select(key, false);
                    try { window.localStorage.setItem('ovv-tab', key); } catch (e) { /* private mode */ }
                });
                b.addEventListener('keydown', function (e) {
                    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
                    let to = null;
                    if (step) to = buttons[(i + step + buttons.length) % buttons.length];
                    else if (e.key === 'Home') to = buttons[0];
                    else if (e.key === 'End') to = buttons[buttons.length - 1];
                    if (!to) return;
                    e.preventDefault();
                    select(to.getAttribute('data-ovv-tab'), true);
                });
            });
        });
    }

    // Links that open a folded panel on this page (More → Manage), and the same for an address that names one.
    function openers() {
        const open = function (id) {
            const d = document.getElementById(id);
            if (!d || d.tagName !== 'DETAILS') return false;
            d.open = true;
            d.scrollIntoView({ block: 'start', behavior: 'smooth' });
            const first = d.querySelector('input, textarea, select');
            if (first) setTimeout(function () { first.focus({ preventScroll: true }); }, 300);
            return true;
        };
        document.querySelectorAll('[data-ovv-open]').forEach(function (a) {
            a.addEventListener('click', function (e) { if (open(a.getAttribute('data-ovv-open'))) e.preventDefault(); });
        });
        if (window.location.hash.length > 1) open(window.location.hash.slice(1));
    }

    // Share: the page's link, at the current time once it plays; the phone's share sheet where there is one.
    function share(video) {
        document.querySelectorAll('[data-ovv-share]').forEach(function (b) {
            if (!navigator.share && !navigator.clipboard) return;
            b.hidden = false;
            const label = b.innerHTML;
            b.addEventListener('click', function () {
                let url = b.getAttribute('data-ovv-share');
                try {
                    const u = new URL(url);
                    if (video && video.currentTime > 3 && !video.ended) u.searchParams.set('t', String(Math.floor(video.currentTime)));
                    url = u.toString();
                } catch (e) { /* the page's own link */ }
                const title = (document.querySelector('.ovv-title') || {}).textContent || document.title;
                if (navigator.share && window.matchMedia('(hover: none)').matches) {
                    navigator.share({ title: title, url: url }).catch(function () { /* closed */ });
                    return;
                }
                navigator.clipboard.writeText(url).then(function () {
                    b.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i> Link copied';
                    setTimeout(function () { b.innerHTML = label; }, 2000);
                }, function () { window.prompt('Copy this link', url); });
            });
        });
    }

    // The transcript follows the video (the line being said is marked and kept in view inside its panel, unless the
    // reader scrolled it lately or is searching), and its search box keeps only the lines that have the words.
    function transcript(video) {
        const body = document.querySelector('[data-ovv-transcript]');
        if (!body) return;
        const lines = Array.prototype.slice.call(body.querySelectorAll('.ovv-line'));
        const wrap = document.querySelector('[data-ovv-search-wrap]');
        const input = wrap && wrap.querySelector('[data-ovv-search]');
        const empty = body.querySelector('[data-ovv-search-empty]');
        let searching = false;
        if (wrap && input) {
            wrap.hidden = false;
            input.addEventListener('input', function () {
                const q = input.value.trim().toLowerCase();
                searching = !!q;
                let shown = 0;
                lines.forEach(function (l) {
                    const hit = !q || l.textContent.toLowerCase().indexOf(q) !== -1;
                    l.hidden = !hit;
                    if (hit) shown++;
                });
                if (empty) empty.hidden = shown > 0;
            });
        }
        if (!video) return;
        let current = null;
        let userScrollUntil = 0;
        let lastAutoScroll = 0;
        body.addEventListener('scroll', function () {
            if (Date.now() - lastAutoScroll > 250) userScrollUntil = Date.now() + 5000;
        });
        video.addEventListener('timeupdate', function () {
            const t = video.currentTime;
            let at = null;
            for (let i = 0; i < lines.length; i++) {
                if (Number(lines[i].getAttribute('data-ovv-at')) <= t + 0.25) at = lines[i];
                else break;
            }
            if (at === current) return;
            if (current) current.classList.remove('is-current');
            current = at;
            if (!at) return;
            at.classList.add('is-current');
            if (searching || Date.now() < userScrollUntil || !body.offsetParent) return;
            lastAutoScroll = Date.now();
            const pr = body.getBoundingClientRect();
            const rr = at.getBoundingClientRect();
            const top = rr.top - pr.top + body.scrollTop;
            if (top < body.scrollTop || top + rr.height > body.scrollTop + body.clientHeight) body.scrollTop = Math.max(0, top - body.clientHeight / 3);
        });
    }

    document.addEventListener('DOMContentLoaded', function () {
        // A clip still being cut: look again in a few seconds (the server answers once it is ready).
        const cutting = document.querySelector('[data-ovv-reload]');
        if (cutting) {
            const wait = Math.max(3, Number(cutting.getAttribute('data-ovv-reload')) || 8) * 1000;
            setTimeout(function () { window.location.replace(window.location.pathname); }, wait);
        }

        menus();
        copyButtons();
        tabs();
        openers();
        share(document.querySelector('video[data-ovv-video]'));

        const video = document.querySelector('video[data-ovv-video]');
        transcript(video);
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
