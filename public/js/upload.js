/* OpenVibe.MediaHub — the drive's one script: the chunked upload, and what makes the drive feel like an app.
 *
 * Every form it upgrades works without it: the upload form posts one file to POST /files/upload, the menus are
 * <details>, sort is a GET form, rename/move/delete are POSTs. With this script:
 *   - files go up in parts (POST /api/v1/files, one PUT per part, then complete), so a file larger than the
 *     single-request limit still uploads, and many files go up one after another;
 *   - files dropped anywhere on a drive page upload into the folder on screen, and a tray shows each one's progress;
 *     when they are in, the list is refreshed in place;
 *   - the grid/list view and the sort are remembered; the search box filters what is on screen as you type;
 *   - one menu is open at a time, and a click outside or Escape closes it; a delete asks first.
 *
 * Every request is same-origin, so the browser sends Sec-Fetch-Site: same-origin by itself — which is exactly what
 * a session-cookie write on this site requires. No token, no key and no file name is ever put in a URL.
 *
 * Pages swap in place (openvibe-shared/boost): listeners live on document (bound once), and wire() runs again on
 * every ov:boost:load.
 */
(function () {
    'use strict';
    if (window.__dlDrive) return;
    window.__dlDrive = true;
    var store = {
        get: function (k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private window */ } },
    };
    var SVG = {
        upload: 'M12 15V4M7.5 8.5 12 4l4.5 4.5M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15',
        file: 'M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5',
        check: 'M5 12.5l4.5 4.5L19 7.5',
        close: 'M6 6l12 12M18 6 6 18',
    };
    function icon(name) {
        var ns = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'dr-i');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS(ns, 'path');
        path.setAttribute('d', SVG[name] || SVG.file);
        svg.appendChild(path);
        return svg;
    }
    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    }
    function bytes(n) {
        if (n < 1024) return n + ' B';
        var units = ['KB', 'MB', 'GB', 'TB'];
        var v = n / 1024;
        var i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
        return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
    }

    // ── The upload itself: one file, in parts ────────────────────────────────────────────────────────────────
    function problem(res) {
        return res.json().then(function (p) {
            return (p && p.detail) || 'The upload was refused.';
        }, function () { return 'The upload was refused (' + res.status + ').'; });
    }
    /** One request, answering a promise of its JSON (or rejecting with the problem's detail). */
    function request(url, options) {
        return fetch(url, options).then(function (res) {
            if (res.ok) return res.status === 204 ? null : res.json().catch(function () { return null; });
            return problem(res).then(function (detail) { throw new Error(detail); });
        });
    }
    /** Upload one file into a folder (or the root); onProgress(sent, total). Resolves with the stored file. */
    function sendFile(file, folderId, name, onProgress) {
        var sent = 0;
        var uploadId = null;
        onProgress(0, file.size);
        return request('/api/v1/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: name || file.name,
                size: file.size,
                content_type: file.type || 'application/octet-stream',
                folder_id: folderId || null,
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
                            onProgress(sent, file.size);
                        });
                    };
                }(n));
            }
            return chain;
        }).then(function () {
            return request('/api/v1/uploads/' + uploadId + '/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        }).then(function (done) { return done.file; });
    }

    // ── The tray: every file being uploaded, one row each ────────────────────────────────────────────────────
    var tray = null;
    var queue = [];
    var running = false;
    var finished = { ok: 0, bad: 0 };
    function trayHead() {
        var left = queue.length + (running ? 1 : 0);
        var text = left ? 'Uploading ' + left + ' file' + (left === 1 ? '' : 's') + '…'
            : finished.bad ? finished.ok + ' uploaded, ' + finished.bad + ' did not go through'
                : finished.ok + ' file' + (finished.ok === 1 ? '' : 's') + ' uploaded';
        tray.querySelector('.dr-tray-head span').textContent = text;
    }
    function ensureTray() {
        if (tray && document.body.contains(tray)) return tray;
        tray = el('section', 'dr-tray');
        tray.setAttribute('aria-label', 'Uploads');
        tray.setAttribute('aria-live', 'polite');
        var head = el('div', 'dr-tray-head');
        head.appendChild(el('span'));
        var close = el('button');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close the upload list');
        close.appendChild(icon('close'));
        close.addEventListener('click', function () {
            if (running || queue.length) return;   // stays while anything is still going up
            tray.remove();
            tray = null;
            finished = { ok: 0, bad: 0 };
        });
        head.appendChild(close);
        tray.appendChild(head);
        tray.appendChild(el('ul'));
        document.body.appendChild(tray);
        return tray;
    }
    function addRow(file) {
        var t = ensureTray();
        var li = el('li');
        var th = el('span', 'dr-thumb');
        th.setAttribute('data-kind', /^image\//.test(file.type) ? 'image' : /^video\//.test(file.type) ? 'video' : /^audio\//.test(file.type) ? 'audio' : 'file');
        th.appendChild(icon('file'));
        li.appendChild(th);
        li.appendChild(el('span', 'dr-tray-name', file.name));
        var state = el('span', 'dr-tray-state', 'Waiting');
        li.appendChild(state);
        var bar = el('span', 'dr-tray-bar');
        bar.appendChild(el('i'));
        li.appendChild(bar);
        t.querySelector('ul').appendChild(li);
        return li;
    }
    function enqueue(files, folderId, name) {
        for (var i = 0; i < files.length; i++) {
            if (!files[i] || (files[i].size === 0 && !files[i].type)) continue;   // a dropped folder arrives as an empty, typeless entry
            queue.push({ file: files[i], folderId: folderId, name: files.length === 1 ? name : '', row: addRow(files[i]) });
        }
        if (tray) trayHead();
        next();
    }
    function next() {
        if (running) return;
        var job = queue.shift();
        if (!job) { if (tray) trayHead(); refreshList(); return; }
        running = true;
        trayHead();
        var state = job.row.querySelector('.dr-tray-state');
        var fill = job.row.querySelector('.dr-tray-bar i');
        sendFile(job.file, job.folderId, job.name, function (sent, total) {
            var pct = total ? Math.round((sent / total) * 100) : 100;
            fill.style.width = pct + '%';
            state.textContent = pct + '% of ' + bytes(total);
        }).then(function (stored) {
            finished.ok += 1;
            job.row.classList.add('is-done');
            fill.style.width = '100%';
            state.textContent = '';
            var open = el('a', null, 'Open');
            open.href = '/files/' + stored.id;
            state.appendChild(open);
        }, function (err) {
            finished.bad += 1;
            job.row.classList.add('is-bad');
            state.textContent = (err && err.message) || 'Did not go through';
        }).then(function () {
            running = false;
            next();
        });
    }

    /** After uploads: draw the folder again in place (the same page, fetched), so new files appear without a reload. */
    function refreshList() {
        var main = document.querySelector('[data-main]');
        if (!main || !finished.ok || !window.DOMParser) return;
        fetch(window.location.href, { credentials: 'same-origin' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (text) {
            if (!text) return;
            var doc = new DOMParser().parseFromString(text, 'text/html');
            var fresh = doc.querySelector('[data-main]');
            var meter = doc.querySelector('.dr-meter');
            if (fresh) main.innerHTML = fresh.innerHTML;
            var oldMeter = document.querySelector('.dr-meter');
            if (meter && oldMeter) oldMeter.outerHTML = meter.outerHTML;
            wire();
        }).catch(function () { /* the next visit shows them */ });
    }

    function folderOfPage() {
        var f = document.querySelector('form[data-upload] input[name=folder]');
        return f ? f.value : null;
    }
    function placeName() {
        var d = document.querySelector('[data-drive]');
        return (d && d.getAttribute('data-place')) || 'your files';
    }

    // ── Drop anywhere ────────────────────────────────────────────────────────────────────────────────────────
    var drop = null;
    var depth = 0;
    function hasFiles(e) {
        var types = e.dataTransfer && e.dataTransfer.types;
        if (!types) return false;
        for (var i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
        return false;
    }
    function showDrop(on) {
        if (on && !drop) {
            drop = el('div', 'dr-drop');
            var box = el('div', 'dr-drop-box');
            box.appendChild(icon('upload'));
            box.appendChild(el('b', null, 'Drop to upload'));
            box.appendChild(el('span', null, 'into ' + placeName()));
            drop.appendChild(box);
            document.body.appendChild(drop);
        } else if (!on && drop) {
            drop.remove();
            drop = null;
        }
    }
    document.addEventListener('dragenter', function (e) {
        if (!document.querySelector('form[data-upload]') || !hasFiles(e)) return;
        e.preventDefault();
        depth += 1;
        showDrop(true);
    });
    document.addEventListener('dragover', function (e) {
        if (!document.querySelector('form[data-upload]') || !hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', function () {
        depth = Math.max(0, depth - 1);
        if (!depth) showDrop(false);
    });
    document.addEventListener('drop', function (e) {
        if (!document.querySelector('form[data-upload]') || !hasFiles(e)) return;
        e.preventDefault();
        depth = 0;
        showDrop(false);
        enqueue(e.dataTransfer.files, folderOfPage(), '');
    });

    // ── The upload form: choosing files starts them; submitting (a name typed) does too ─────────────────────
    document.addEventListener('change', function (e) {
        var t = e.target;
        if (t.matches && t.matches('form[data-upload] input[type=file]') && t.files && t.files.length) {
            var form = t.form;
            var nameField = form.querySelector('input[name=name]');
            enqueue(t.files, folderOfPage(), nameField ? nameField.value : '');
            t.value = '';
            if (nameField) nameField.value = '';
            var det = form.closest('details');
            if (det) det.open = false;
            return;
        }
        if (t.matches && t.matches('select[data-autosubmit]')) {
            // Remembered for the next visit: the server reads it when the address names no sort.
            if (t.name === 'sort') document.cookie = 'dl_sort=' + encodeURIComponent(t.value) + '; path=/; max-age=31536000; samesite=lax';
            t.form.requestSubmit ? t.form.requestSubmit() : t.form.submit();
            return;
        }
        if (t.matches && t.matches('.dr-view input')) {
            store.set('dl.view', t.value);
            return;
        }
        if (t.matches && t.matches('.fv-who input[value=named]') && t.checked) {
            var names = document.getElementById('usernames');
            if (names) names.focus();
        }
    });
    document.addEventListener('submit', function (e) {
        var form = e.target;
        if (form.matches('form[data-upload]')) {
            var input = form.querySelector('input[type=file]');
            if (!input || !input.files || !input.files.length) return;   // nothing chosen: let the server answer
            e.preventDefault();
            var nameField = form.querySelector('input[name=name]');
            enqueue(input.files, folderOfPage(), nameField ? nameField.value : '');
            input.value = '';
            return;
        }
        var ask = form.getAttribute('data-confirm');
        if (ask && !window.confirm(ask)) e.preventDefault();
    }, true);

    // ── Menus: one open at a time; outside click and Escape close ───────────────────────────────────────────
    document.addEventListener('toggle', function (e) {
        var d = e.target;
        if (!d.matches || !d.matches('.dr-more, .dr-new') || !d.open) return;
        document.querySelectorAll('.dr-more[open], .dr-new[open]').forEach(function (o) { if (o !== d) o.open = false; });
        var first = d.querySelector('.dr-menu a, .dr-new-panel .dr-pick');
        if (first && window.matchMedia('(hover: hover)').matches) first.focus({ preventScroll: true });
    }, true);
    document.addEventListener('click', function (e) {
        document.querySelectorAll('.dr-more[open], .dr-new[open]').forEach(function (o) {
            var panel = o.querySelector('.dr-menu, .dr-new-panel');
            if (panel && panel.contains(e.target)) return;
            if (o.querySelector('summary').contains(e.target)) return;
            o.open = false;
        });
    });
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var open = document.querySelector('.dr-more[open], .dr-new[open]');
        if (!open) return;
        open.open = false;
        open.querySelector('summary').focus();
    });

    // ── Filter what is on screen as you type; Enter searches every folder ───────────────────────────────────
    document.addEventListener('input', function (e) {
        if (!e.target.matches('[data-filter]')) return;
        var q = e.target.value.trim().toLowerCase();
        var shown = 0;
        var total = 0;
        document.querySelectorAll('[data-items] > li').forEach(function (li) {
            total += 1;
            var hit = !q || (li.getAttribute('data-name') || '').indexOf(q) !== -1;
            li.hidden = !hit;
            if (hit) shown += 1;
        });
        document.querySelectorAll('.dr-sec').forEach(function (sec) {
            var list = sec.querySelector('[data-items]');
            if (list) sec.hidden = !!q && !list.querySelector(':scope > li:not([hidden])');
        });
        var none = document.querySelector('[data-nomatch]');
        if (none) none.hidden = !(q && total && !shown);
    });

    // ── Per page (again after every in-place swap) ──────────────────────────────────────────────────────────
    function wire() {
        // The form's "Name + Upload" row is for pages without this script: here, choosing files starts them.
        document.querySelectorAll('[data-nojs]').forEach(function (n) { n.hidden = true; });
        document.querySelectorAll('form[data-upload] input[type=file]').forEach(function (i) { i.multiple = true; i.required = false; });
        var view = store.get('dl.view');
        if (view) {
            var radio = document.querySelector('.dr-view input[value="' + (view === 'list' ? 'list' : 'grid') + '"]');
            if (radio) radio.checked = true;
        }
        if (navigator.clipboard) {
            document.querySelectorAll('[data-copy]').forEach(function (b) {
                b.hidden = false;
                if (b.__wired) return;
                b.__wired = true;
                b.addEventListener('click', function () {
                    navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
                        var was = b.textContent;
                        b.textContent = 'Copied';
                        setTimeout(function () { b.textContent = was; }, 1600);
                    }, function () { /* the link is on screen to copy by hand */ });
                });
            });
        }
        // Dates in the reader's own zone, the full time on hover.
        document.querySelectorAll('time[data-when]').forEach(function (t) {
            var d = new Date(t.getAttribute('datetime'));
            if (isNaN(d)) return;
            var sameYear = d.getFullYear() === new Date().getFullYear();
            t.textContent = d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
            t.title = d.toLocaleString();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
    document.addEventListener('ov:boost:load', wire);
})();
