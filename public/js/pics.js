/*
 * OpenVibe.Pics on top of the plain forms (server/pics/pages.js): drop or paste pictures, several at once, each sent
 * to POST /api/v1/images with a progress bar, then its links to copy. Copy buttons ([data-copy]) and confirmations
 * ([data-confirm]) anywhere on the page. Nothing here is needed: without it every form still works.
 * DOM nodes only, never innerHTML.
 */
(function () {
    'use strict';

    function el(tag, props, children) {
        var node = document.createElement(tag);
        Object.keys(props || {}).forEach(function (k) {
            if (k === 'text') node.textContent = props[k];
            else if (k === 'className') node.className = props[k];
            else node.setAttribute(k, props[k]);
        });
        (children || []).forEach(function (c) { if (c) node.appendChild(c); });
        return node;
    }

    function copyFrom(input, button) {
        var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy'; }, 1600); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
        } else {
            input.select();
            try { document.execCommand('copy'); done(); } catch (e) { /* the text is selected; the person copies it */ }
        }
    }

    document.addEventListener('click', function (ev) {
        var btn = ev.target.closest('[data-copy]');
        if (!btn) return;
        var input = document.getElementById(btn.getAttribute('data-copy'));
        if (input) copyFrom(input, btn);
    });
    document.addEventListener('submit', function (ev) {
        var msg = ev.target.getAttribute && ev.target.getAttribute('data-confirm');
        if (msg && !window.confirm(msg)) ev.preventDefault();
    });

    var form = document.querySelector('[data-pics-upload]');
    if (!form || !window.XMLHttpRequest || !window.FormData) return;
    var input = form.querySelector('[data-pics-input]');
    var results = form.querySelector('[data-pics-results]');
    var max = Number(form.getAttribute('data-max')) || 0;
    var TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'];
    var queue = [];
    var busy = false;
    var seq = 0;

    form.classList.add('is-enhanced');
    input.multiple = true;
    input.required = false;

    function copyRow(label, value) {
        var id = 'up-' + (++seq);
        var field = el('input', { id: id, type: 'text', readonly: '', spellcheck: 'false', 'aria-label': label });
        field.value = value;
        return el('div', { className: 'ovp-copy-row' }, [field, el('button', { className: 'ovp-btn', type: 'button', 'data-copy': id, text: 'Copy' })]);
    }

    function row(file) {
        var bar = el('span');
        var main = el('div', { className: 'ovp-result-main' }, [el('div', { className: 'ovp-result-name', text: file.name || 'Pasted picture' }), el('div', { className: 'ovp-progress', role: 'progressbar', 'aria-label': 'Uploading' }, [bar])]);
        var img = el('img', { alt: '' });
        try { img.src = URL.createObjectURL(file); } catch (e) { img = el('span', { className: 'ovp-result-ph' }); }
        var li = el('li', { className: 'ovp-result' }, [img, main]);
        results.prepend(li);
        return { li: li, main: main, bar: bar };
    }

    function fail(r, text) {
        var p = r.main.querySelector('.ovp-progress');
        if (p) p.remove();
        r.main.appendChild(el('div', { className: 'ovp-result-error', text: text }));
    }

    function send(file, r) {
        return new Promise(function (resolve) {
            var xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/v1/images');
            xhr.setRequestHeader('Content-Type', file.type);
            xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'pasted'));
            xhr.upload.onprogress = function (e) { if (e.lengthComputable) r.bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
            xhr.onload = function () {
                var body = null;
                try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
                if (xhr.status === 201 && body && body.links) {
                    var p = r.main.querySelector('.ovp-progress');
                    if (p) p.remove();
                    var name = r.main.querySelector('.ovp-result-name');
                    name.textContent = '';
                    name.appendChild(el('a', { href: body.links.page, text: body.title || 'Your picture' }));
                    r.main.appendChild(copyRow('Link to the picture’s page', body.links.page));
                    r.main.appendChild(copyRow('Direct link', body.links.direct));
                    if (body.delete_url) r.main.appendChild(el('div', { className: 'ovp-result-error', text: 'Keep this delete link, shown only now: ' + body.delete_url }));
                } else if (xhr.status === 401) {
                    fail(r, 'Sign in with OpenVibe to upload.');
                } else {
                    fail(r, (body && body.detail) || 'That picture could not be uploaded. Try again.');
                }
                resolve();
            };
            xhr.onerror = function () { fail(r, 'The connection dropped. Try again.'); resolve(); };
            xhr.send(file);
        });
    }

    function pump() {
        if (busy || !queue.length) return;
        busy = true;
        var job = queue.shift();
        send(job.file, job.r).then(function () { busy = false; pump(); });
    }

    function add(files) {
        Array.prototype.forEach.call(files, function (file) {
            var r = row(file);
            if (TYPES.indexOf(file.type) === -1) return fail(r, 'Pictures can be JPEG, PNG, GIF, WebP or AVIF.');
            if (max && file.size > max) return fail(r, 'This picture is larger than ' + Math.round(max / 1048576) + ' MB.');
            queue.push({ file: file, r: r });
            return undefined;
        });
        pump();
    }

    input.addEventListener('change', function () { if (input.files && input.files.length) add(input.files); input.value = ''; });
    form.addEventListener('submit', function (ev) { ev.preventDefault(); if (input.files && input.files.length) add(input.files); });

    var depth = 0;
    document.addEventListener('dragenter', function (e) { if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1) { depth++; form.classList.add('is-dragover'); } });
    document.addEventListener('dragleave', function () { depth = Math.max(0, depth - 1); if (!depth) form.classList.remove('is-dragover'); });
    document.addEventListener('dragover', function (e) { if (form.classList.contains('is-dragover')) e.preventDefault(); });
    document.addEventListener('drop', function (e) {
        if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
        e.preventDefault();
        depth = 0;
        form.classList.remove('is-dragover');
        add(e.dataTransfer.files);
    });
    document.addEventListener('paste', function (e) {
        var t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'file') return;
        var items = (e.clipboardData && e.clipboardData.files) || [];
        if (items.length) { e.preventDefault(); add(items); }
    });
})();
