/* vod-pip.js — the picture-in-pictures that were on screen during a recording, played over it again.
 *
 * OpenVibe.Live records each PIP span (streaming/pip-history.js) and its VOD API answers them as
 * [{ vod_id, file, hls, from, to, offset, x, y, w, muted, missing }] (OpenVibe.MediaHub server/video/pages.js
 * pipsOf): the PIP VOD's second at `from` is `offset`, so while from <= t < to it plays at offset + (t - from).
 *
 * What this file does (owner, 2026-11-13: "the robot PiP freezes on VODs — play it in sync with the main VOD"):
 * - the PIP is a second <video> that follows the main one: play, pause, seek, speed, and a wait on either side
 *   pauses the other; drift over 0.3 s is nudged with playbackRate (0.95–1.05 × the main's rate) and over 2 s
 *   is seeked;
 * - outside its span it hides (no last-frame freeze); several spans may cover the recording, and overlapping
 *   ones are all drawn;
 * - a span whose PIP VOD Live no longer has says so once, quietly, and hides;
 * - the box is openvibe-shared/ov-float.js (OVFloat.attach): drag, tuck, size, its place kept per device; a tap
 *   (or Enter) swaps it with the main view, and the box shows the main recording until the next tap.
 *
 * The two pure functions the player's correctness rests on are exported (window.VodPip / module.exports):
 * activeSpan/ pipTimeAt/ hostTimeAt map either direction, and driftCorrection picks none/nudge/seek.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) { module.exports = factory(); return; }
    root.VodPip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const NUDGE_AT = 0.3;       // drift (s) that starts the playbackRate nudge
    const SEEK_AT = 2;          // drift (s) that a seek fixes outright
    const NUDGE_GAIN = 0.1;     // 0.1 s of drift → 1% slower/faster
    const NUDGE_MAX = 0.05;     // never outside 0.95–1.05 × the main's rate
    const TICK_MS = 250;        // how often the small player is checked against the big one
    const LOAD_AHEAD = 10;      // seconds before its span that a PIP's file is loaded
    const TAP_PX = 4;           // a press that moves less is a tap (OVFloat's own threshold)
    const HOLD_MS = 450;        // a PIP that waits this long pauses the main one too

    const clamp = (v, lo, hi, dflt) => {
        const n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    };

    /* ── pure: the two timelines ──────────────────────────────────────────────────────────────────────────── */

    /** The span on screen at `t` (seconds of the main recording), or null: [from, to), latest first on overlap. */
    function activeSpan(spans, t) {
        if (!Array.isArray(spans) || !Number.isFinite(t)) return null;
        let pick = null;
        for (const span of spans) {
            if (!span || !Number.isFinite(Number(span.from)) || !Number.isFinite(Number(span.to))) continue;
            if (t >= Number(span.from) && t < Number(span.to)) pick = span;
        }
        return pick;
    }

    /** The PIP's own second at this second of the main recording: offset + (t - from); null outside the span. */
    function pipTimeAt(span, t) {
        if (!span || !Number.isFinite(t)) return null;
        const from = Number(span.from), to = Number(span.to), offset = Number(span.offset);
        if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(offset)) return null;
        if (t < from || t >= to) return null;
        return offset + (t - from);
    }

    /** The main recording's second for this second of the PIP's VOD (the inverse mapping); null outside it. */
    function hostTimeAt(span, pipTime) {
        if (!span || !Number.isFinite(pipTime)) return null;
        const from = Number(span.from), to = Number(span.to), offset = Number(span.offset);
        if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(offset)) return null;
        const end = offset + (to - from);
        if (pipTime < offset || pipTime >= end) return null;
        return from + (pipTime - offset);
    }

    /**
     * What to do about `actual` (the PIP's currentTime) when it should be at `expected`.
     *   { action: 'none' | 'nudge' | 'seek', rate, time }
     * A seek beyond 2 s, a nudge between 0.3 s and 2 s (0.95–1.05 × baseRate, proportional to the drift), and
     * `rate: baseRate` in the dead zone. The factor is within 0.95–1.05 whatever the main's speed; `rate` is
     * the factor times baseRate so a 2× main stays 2× while it catches up.
     */
    function driftCorrection(actual, expected, baseRate) {
        const base = Number.isFinite(Number(baseRate)) && Number(baseRate) > 0 ? Number(baseRate) : 1;
        if (!Number.isFinite(Number(expected))) return { action: 'none', rate: base, time: null, drift: 0, factor: 1 };
        if (!Number.isFinite(Number(actual))) return { action: 'seek', rate: base, time: Number(expected), drift: 0, factor: 1 };
        const d = Number(actual) - Number(expected);
        const abs = Math.abs(d);
        if (abs > SEEK_AT + 1e-9) return { action: 'seek', rate: base, time: Number(expected), drift: d, factor: 1 };
        if (abs > NUDGE_AT + 1e-9) {
            const factor = Math.min(1 + NUDGE_MAX, Math.max(1 - NUDGE_MAX, 1 - d * NUDGE_GAIN));
            return { action: 'nudge', rate: base * factor, time: null, drift: d, factor };
        }
        return { action: 'none', rate: base, time: null, drift: d, factor: 1 };
    }

    /* ── the player ───────────────────────────────────────────────────────────────────────────────────────── */

    /** /watch?v=<id>&t=… keeps one place per recording: the moment is not part of the key. */
    function pageKey() {
        if (typeof location === 'undefined') return '';
        try {
            const u = new URL(location.href);
            u.searchParams.delete('t');
            return u.pathname + (u.search || '');
        } catch { return location.pathname || ''; }
    }

    function glyph(name) {
        return '<i class="ovg-fill" data-ov-icon="' + name + '" aria-hidden="true"></i>';
    }

    /**
     * Put the PIPs over `main` (the page's video[data-ovv-video]).
     *   options.data        the PIP list (default: the [data-ovv-pips] JSON beside the player)
     *   options.attachSource the page's HLS/file loader, if a PIP VOD has a playlist (video.js's attachSource)
     *   options.root        the frame the float docks in (default: the shared player's .ov-player)
     * Returns { items, spans, swap, destroy, sync } for tests and the page.
     */
    function attach(main, options) {
        const o = options || {};
        if (!main || typeof main.addEventListener !== 'function') return null;
        let spans = o.data;
        if (!Array.isArray(spans)) {
            const holder = main.parentNode && main.parentNode.querySelector('[data-ovv-pips]');
            try { spans = JSON.parse(holder ? holder.textContent : (document.querySelector('[data-ovv-pips]') || {}).textContent || '[]'); } catch { spans = []; }
        }
        if (!Array.isArray(spans) || !spans.length) return null;

        const root = o.root || main.closest('.ov-player') || main.parentNode;
        if (!root) return null;
        const loader = typeof o.attachSource === 'function' ? o.attachSource : null;
        const state = { items: [], missing: [], swapped: null, host: null, intent: main.paused ? 'pause' : 'play',
            bufferHold: false, swapping: false, missingShown: false, destroyed: false, timer: 0 };
        const valid = spans.filter((p) => p && !p.missing && p.file && Number.isFinite(Number(p.from)) && Number(p.to) > Number(p.from)
            && Number.isFinite(Number(p.offset)));
        const missing = spans.filter((p) => p && p.missing && Number.isFinite(Number(p.from)) && Number(p.to) > Number(p.from));
        if (!valid.length && !missing.length) return null;

        const tick = () => { if (!state.destroyed) sync(false); };

        function makeIt(p) {
            const it = { p: p, box: null, video: null, name: null, mute: null, swapBtn: null, float: null,
                aspect: 16 / 9, loaded: false, waiting: false, waitTimer: 0, primed: false, needsAlign: false, started: false,
                g: { muted: p.muted !== false } };
            return it;
        }

        function paintMute(it) {
            if (!it.mute || !it.video) return;
            const muted = !!(it.g && it.g.muted) || main.muted;
            it.video.muted = muted;
            it.mute.innerHTML = glyph(muted ? 'mute' : 'volume');
            const what = state.swapped === it ? 'the main recording' : it.p.title;
            it.mute.title = (muted ? 'Turn on ' : 'Mute ') + what;
            it.mute.setAttribute('aria-label', it.mute.title);
            it.mute.hidden = state.swapped === it;
        }

        function paintLabel(it) {
            if (!it.name) return;
            const swapped = state.swapped === it;
            it.box.classList.toggle('is-swapped', swapped);
            it.name.textContent = swapped ? (document.querySelector('.ovv-head h1') || {}).textContent || 'The main recording' : it.p.title;
            it.name.href = swapped ? location.pathname + location.search : it.p.href;
            it.box.setAttribute('aria-label', swapped
                ? 'Showing the main recording. Tap to swap back.'
                : 'Picture-in-picture: ' + it.p.title + '. Tap to swap it with the main video.');
            if (it.swapBtn) it.swapBtn.title = swapped ? 'Swap back with the main video' : 'Swap with the main video';
            paintMute(it);
        }

        function setSource(video, file, hls, hlsLib) {
            if (!video || !file) return Promise.resolve();
            if (video._ovvHls) { try { video._ovvHls.destroy(); } catch { /* gone */ } video._ovvHls = null; }
            video.removeAttribute('data-ovv-hls');
            if (hls) {
                video.setAttribute('data-ovv-hls', hls);
                if (hlsLib) video.setAttribute('data-ovv-hls-lib', hlsLib);
            } else {
                video.removeAttribute('data-ovv-hls-lib');
            }
            video.setAttribute('src', file);
            return loader ? Promise.resolve(loader(video)).catch(() => {}) : Promise.resolve();
        }

        function whenMetadata(video) {
            return new Promise((resolve) => {
                if (!video) { resolve(); return; }
                if (video.readyState >= 1) { resolve(); return; }
                let done = false;
                const finish = () => { if (done) return; done = true; video.removeEventListener('loadedmetadata', finish); resolve(); };
                video.addEventListener('loadedmetadata', finish, { once: true });
                setTimeout(finish, 4000);
            });
        }

        function readShape(it, video) {
            if (!video || !video.videoWidth || !video.videoHeight) return;
            it.aspect = video.videoWidth / video.videoHeight;
            if (it.float) it.float.setAspect(it.aspect);
        }

        function ensureBuilt(it) {
            if (it.box) return it;
            const p = it.p;
            const box = document.createElement('div');
            box.className = 'ovv-pip';
            box.hidden = true;
            box.tabIndex = 0;
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label', 'Picture-in-picture: ' + p.title + '. Tap to swap it with the main video.');
            const video = document.createElement('video');
            video.className = 'ovv-pip-video';
            video.playsInline = true;
            video.preload = 'none';
            video.muted = true;
            video.setAttribute('aria-hidden', 'true');
            const bar = document.createElement('div');
            bar.className = 'ovv-pip-bar';
            const name = document.createElement('a');
            name.className = 'ovv-pip-name';
            name.href = p.href;
            name.textContent = p.title;
            const swapBtn = document.createElement('button');
            swapBtn.type = 'button';
            swapBtn.innerHTML = glyph('arrows-h');
            swapBtn.title = 'Swap with the main video';
            swapBtn.setAttribute('aria-label', 'Swap ' + p.title + ' with the main video');
            const mute = document.createElement('button');
            mute.type = 'button';
            mute.innerHTML = glyph('mute');
            bar.append(name, swapBtn, mute);
            box.append(video, bar);
            root.appendChild(box);
            it.box = box; it.video = video; it.name = name; it.mute = mute; it.swapBtn = swapBtn;

            box.addEventListener('click', (e) => { e.stopPropagation(); });
            swapBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); swap(it); });
            mute.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                if (!it.g) return;
                it.g.muted = !it.g.muted;
                if (it.float) it.float.set({ muted: it.g.muted }, { save: true });
                paintMute(it);
            });
            video.addEventListener('loadedmetadata', () => { readShape(it, video); it.primed = false; });
            video.addEventListener('resize', () => readShape(it, video));
            video.addEventListener('waiting', () => waiting(it));
            video.addEventListener('stalled', () => waiting(it));
            ['playing', 'canplay', 'seeked'].forEach((ev) => video.addEventListener(ev, () => ready(it)));
            // Its media clock starts a little after play() resolves (and after a buffer): align once more on the next
            // tick, so a slow start does not leave it half a second behind waiting for the 5% nudge to catch up.
            video.addEventListener('playing', () => {
                if (it.started) return;
                it.started = true;
                it.needsAlign = true;
            });
            video.addEventListener('play', () => { if (state.bufferHold) video.pause(); });
            video.addEventListener('error', () => { it.waiting = false; });

            // A tap on the box (not its buttons or title link, and not a drag) swaps it with the main view. OVFloat
            // takes the pointer for its move; this listener sees the same pointer first and only counts a still one.
            let tap = null;
            box.addEventListener('pointerdown', (e) => {
                if (e.button > 0 || (e.target.closest && e.target.closest('button, a, .ov-float-resize, [data-ov-float-resize]'))) { tap = null; return; }
                tap = { id: e.pointerId, x: e.clientX, y: e.clientY };
            }, true);
            box.addEventListener('pointerup', (e) => {
                const s = tap; tap = null;
                if (!s || s.id !== e.pointerId || state.swapping) return;
                if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > TAP_PX) return;
                if (it.float && it.float.geom().tuck) return;   // a tucked handle's tap opens it instead
                swap(it);
            }, true);
            box.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' || e.target.closest('button, a')) return;
                e.preventDefault(); e.stopPropagation();
                swap(it);
            });
            return it;
        }

        function engine(it) {
            if (it.float || !root || typeof window === 'undefined' || !window.OVFloat) {
                if (!it.float && it.box && !it.box.style.width) {
                    // No shared engine (a page without /shared/ov-float.js): show the PIP where the streamer put it.
                    it.box.style.left = clamp(it.p.x, 0, 1, 0.72) * 100 + '%';
                    it.box.style.top = clamp(it.p.y, 0, 1, 0.7) * 100 + '%';
                    it.box.style.width = clamp(it.p.w, 0.08, 0.6, 0.25) * 100 + '%';
                    it.box.style.aspectRatio = '16 / 9';
                }
                return it.float;
            }
            it.float = window.OVFloat.attach(it.box, {
                frame: root,
                key: 'ovv-pip-' + pageKey() + ':' + it.p.vod_id,
                store: null,   // the place is this device's (localStorage), not the account's
                defaults: { x: it.p.x, y: it.p.y, w: it.p.w, mode: 'dock', muted: it.g.muted },
                aspect: it.aspect || 16 / 9,
                minPx: 150,
                doubleTap: false,   // a tap is the swap; the corner/pinch still sizes it
                onChange: (geom) => { it.g = geom; paintMute(it); },
            });
            it.g = it.float.geom();
            paintMute(it);
            return it.float;
        }

        function load(it) {
            if (it.loaded) return;
            it.loaded = true;
            it.video.preload = 'auto';
            setSource(it.video, it.p.file, it.p.hls, main.getAttribute('data-ovv-hls-lib'));
        }

        function waiting(it) {
            if (!it.video || it.box.hidden || !isActiveNow(it)) return;
            if (it.waiting) return;
            it.waiting = true;
            clearTimeout(it.waitTimer);
            it.waitTimer = setTimeout(() => {
                if (!it.waiting || state.destroyed || it.box.hidden || main.paused || state.bufferHold) return;
                state.bufferHold = true;
                main.pause();
                pauseAll();
            }, HOLD_MS);
        }

        function ready(it) {
            it.waiting = false;
            clearTimeout(it.waitTimer);
            if (!state.bufferHold) return;
            state.bufferHold = false;
            it.needsAlign = true;
            if (state.intent === 'play') {
                const played = main.play();
                if (played && played.catch) played.catch(() => {});
                playAll();
            }
        }

        function isActiveNow(it) {
            const t = main.currentTime;
            if (state.swapped) return state.swapped === it && inSwapped(it, t);
            return t >= Number(it.p.from) && t < Number(it.p.to);
        }

        function inSwapped(it, t) {
            return Number.isFinite(t) && t >= Number(it.p.offset) && t < Number(it.p.offset) + (Number(it.p.to) - Number(it.p.from));
        }

        function expectedOf(it, t) {
            return state.swapped === it ? hostTimeAt(it.p, t) : pipTimeAt(it.p, t);
        }

        function pauseAll() {
            for (const it of state.items) if (it.video && !it.video.paused) it.video.pause();
        }

        function playAll() {
            if (state.bufferHold || state.intent !== 'play' || main.paused) return;
            for (const it of state.items) {
                if (!it.video || it.box.hidden || it.video.readyState < 1) continue;
                if (it.video.paused) { const p = it.video.play(); if (p && p.catch) p.catch(() => {}); }
            }
        }

        function noteMissing(t) {
            if (state.missingShown || state.swapped) return;
            const span = missing.find((p) => t >= Number(p.from) && t < Number(p.to));
            if (!span) return;
            state.missingShown = true;
            let note = document.querySelector('.ovv-pip-note');
            if (!note) {
                note = document.createElement('p');
                note.className = 'ovv-pip-note';
                note.setAttribute('role', 'status');
                const wrap = main.closest('.ovv-player-wrap') || root.parentNode || root;
                if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(note, wrap.nextSibling);
                else root.appendChild(note);
            }
            note.textContent = (span.title ? '“' + span.title + '”' : 'A picture-in-picture') + ' is no longer available, so it is not shown here.';
            note.hidden = false;
        }

        function sync(force) {
            if (state.destroyed || !main || state.swapping) return;
            const t = main.currentTime;
            if (!Number.isFinite(t) || main.readyState < 1) return;
            const wanted = new Set();
            if (state.swapped) {
                const it = state.swapped;
                if (inSwapped(it, t)) wanted.add(it);
            } else {
                for (const it of state.items) {
                    if (t >= Number(it.p.from) - LOAD_AHEAD && t < Number(it.p.to)) { ensureBuilt(it); load(it); }
                    if (t >= Number(it.p.from) && t < Number(it.p.to)) wanted.add(it);
                }
            }
            for (const it of state.items) {
                if (!it.box) continue;
                const on = wanted.has(it);
                if (on) {
                    if (it.box.hidden) {
                        it.box.hidden = false;
                        engine(it);
                        if (it.float) it.float.relayout();
                        it.primed = false;
                    }
                    if (!it.video || it.video.readyState < 1) continue;
                    const expected = expectedOf(it, t);
                    if (expected == null) { it.box.hidden = true; it.video.pause(); continue; }
                    const duration = Number(it.video.duration);
                    if (Number.isFinite(duration) && duration > 0 && expected >= duration - 0.05) {
                        it.box.hidden = true;
                        if (!it.video.paused) it.video.pause();
                        continue;
                    }
                    const base = Number(main.playbackRate) || 1;
                    const actual = Number(it.video.currentTime) || 0;
                    const c = driftCorrection(actual, expected, base);
                    if (force || !it.primed || it.needsAlign) {
                        const at = Math.max(0, Math.min(expected, Number.isFinite(duration) && duration > 0 ? duration - 0.05 : expected));
                        if (Math.abs(actual - at) > 0.08 && it.video.readyState >= 1) it.video.currentTime = at;
                        it.video.playbackRate = base;
                        it.primed = true;
                        it.needsAlign = false;
                    } else if (!main.paused && !it.video.paused && it.video.readyState >= 2) {
                        if (c.action === 'seek') it.video.currentTime = c.time;
                        else it.video.playbackRate = c.rate;
                    } else {
                        it.video.playbackRate = base;
                    }
                    paintMute(it);
                    if (main.paused || state.bufferHold) { if (!it.video.paused) it.video.pause(); }
                    else if (it.video.paused && !state.bufferHold) { const p = it.video.play(); if (p && p.catch) p.catch(() => {}); }
                } else if (!it.box.hidden) {
                    it.box.hidden = true;
                    if (it.video && !it.video.paused) it.video.pause();
                    if (it.float) it.float.save();
                }
            }
            noteMissing(t);
        }

        /* ── swap: main <-> the floating view, sources and times exchanged ───────────────────────────────── */

        function snapshotHost() {
            return {
                file: main.getAttribute('src'),
                hls: main.getAttribute('data-ovv-hls'),
                hlsLib: main.getAttribute('data-ovv-hls-lib'),
                poster: main.getAttribute('poster'),
                tracks: Array.prototype.slice.call(main.querySelectorAll('track')),
                crossorigin: main.getAttribute('crossorigin'),
            };
        }

        function restoreHostTracks(host) {
            main.querySelectorAll('track').forEach((t) => t.remove());
            for (const t of host.tracks) main.appendChild(t);
        }

        function swap(it) {
            if (!it || !it.loaded || !it.video || state.swapping || it.p.missing) return;
            const back = state.swapped === it;
            if (!back && state.swapped) return;   // swap the shown one back first
            if (back && !state.host) return;
            const wasPlaying = !main.paused;
            state.swapping = true;
            const t = main.currentTime;
            main.pause();
            pauseAll();
            if (!back) {
                const pt = pipTimeAt(it.p, t);
                if (pt == null) { state.swapping = false; return; }
                if (!state.host) state.host = snapshotHost();
                const host = state.host;
                const hostAt = t;
                state.swapped = it;
                // The floating view becomes the main recording, at the same second.
                const hostLoad = setSource(it.video, host.file, host.hls, host.hlsLib).then(() => whenMetadata(it.video)).then(() => {
                    if (it.video.readyState >= 1) it.video.currentTime = Math.max(0, hostAt);
                    it.video.muted = true;
                    it.primed = false;
                });
                // The main player becomes the PIP's recording, at the mapped second.
                const pipLoad = setSource(main, it.p.file, it.p.hls, host.hlsLib).then(() => whenMetadata(main)).then(() => {
                    if (main.readyState >= 1) main.currentTime = Math.max(0, pt);
                    restoreHostTracks({ tracks: [] });
                    main.removeAttribute('poster');
                });
                Promise.all([hostLoad, pipLoad]).then(() => {
                    state.swapping = false;
                    state.intent = wasPlaying ? 'play' : 'pause';
                    paintLabel(it);
                    for (const other of state.items) if (other !== it && other.box) other.box.hidden = true;
                    sync(true);
                    if (wasPlaying) { const p = main.play(); if (p && p.catch) p.catch(() => {}); playAll(); }
                });
                return;
            }
            const pt = main.currentTime;
            const hostAt = it.video.currentTime;
            state.swapped = null;
            const backMain = setSource(main, state.host.file, state.host.hls, state.host.hlsLib).then(() => whenMetadata(main)).then(() => {
                if (main.readyState >= 1) main.currentTime = Math.max(0, hostAt);
                if (state.host.poster) main.setAttribute('poster', state.host.poster); else main.removeAttribute('poster');
                if (state.host.crossorigin) main.setAttribute('crossorigin', state.host.crossorigin);
                restoreHostTracks(state.host);
            });
            const backPip = setSource(it.video, it.p.file, it.p.hls, state.host.hlsLib).then(() => whenMetadata(it.video)).then(() => {
                if (it.video.readyState >= 1) it.video.currentTime = Math.max(0, pt);
                it.primed = false;
            });
            Promise.all([backMain, backPip]).then(() => {
                state.swapping = false;
                state.intent = wasPlaying ? 'play' : 'pause';
                paintLabel(it);
                paintMute(it);
                sync(true);
                if (wasPlaying) { const p = main.play(); if (p && p.catch) p.catch(() => {}); playAll(); }
            });
        }

        /* ── wire it to the main player ─────────────────────────────────────────────────────────────────── */

        state.items = valid.map(makeIt);
        state.missing = missing;

        main.addEventListener('play', () => {
            if (!state.bufferHold && !state.swapping) state.intent = 'play';
            for (const it of state.items) it.primed = false;   // a resume after a pause starts the clock again
            sync(true);
        });
        main.addEventListener('pause', () => {
            if (state.bufferHold || state.swapping) return;
            state.intent = 'pause';
            pauseAll();
        });
        main.addEventListener('timeupdate', () => sync(false));
        main.addEventListener('ratechange', () => sync(false));
        main.addEventListener('volumechange', () => { for (const it of state.items) paintMute(it); });
        main.addEventListener('seeking', () => { for (const it of state.items) it.primed = false; });
        main.addEventListener('seeked', () => { for (const it of state.items) it.primed = false; sync(true); });
        main.addEventListener('waiting', () => { pauseAll(); });
        main.addEventListener('playing', () => {
            for (const it of state.items) it.primed = false;   // after its own wait, both start together again
            if (state.intent === 'play' && !state.bufferHold) { playAll(); sync(true); }
        });
        main.addEventListener('ended', () => pauseAll());

        state.timer = setInterval(tick, TICK_MS);
        sync(true);

        return {
            items: state.items,
            spans: spans,
            missing: state.missing,
            swap: (it) => swap(it || state.swapped || state.items[0]),
            sync: (force) => sync(force),
            destroy() {
                state.destroyed = true;
                clearInterval(state.timer);
                for (const it of state.items) {
                    clearTimeout(it.waitTimer);
                    if (it.float) it.float.destroy();
                    if (it.box) it.box.remove();
                }
                state.items = [];
            },
        };
    }

    return { attach, activeSpan, pipTimeAt, hostTimeAt, driftCorrection, NUDGE_AT, SEEK_AT, NUDGE_MAX };
});
