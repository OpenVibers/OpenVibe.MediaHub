/* The local continue-watching card. Video history is kept only in this browser. */
(function () {
    'use strict';
    var mount = document.getElementById('continue-watching');
    if (!mount) return;
    var saved;
    try { saved = JSON.parse(localStorage.getItem('ovv-continue') || 'null'); } catch { return; }
    if (!saved || typeof saved.href !== 'string' || !/^\/(watch|v|c|u)(\/|\?)/.test(saved.href) || !Number.isFinite(saved.at) || saved.at < 5 || Date.now() - saved.updated > 30 * 86400000) return;
    var heading = document.createElement('h2'); heading.textContent = 'Continue watching';
    var link = document.createElement('a'); link.className = 'ovv-continue-card';
    var url = new URL(saved.href, location.origin); url.searchParams.set('t', String(saved.at)); link.href = url.pathname + url.search;
    if (typeof saved.poster === 'string' && /^https:\/\//.test(saved.poster)) {
        var img = document.createElement('img'); img.src = saved.poster; img.alt = ''; img.loading = 'lazy'; link.appendChild(img);
    }
    var copy = document.createElement('span'); copy.className = 'ovv-continue-copy';
    var title = document.createElement('strong'); title.textContent = saved.title || 'Keep watching'; copy.appendChild(title);
    var progress = document.createElement('span'); progress.textContent = Math.floor(saved.at / 60) + ':' + String(saved.at % 60).padStart(2, '0') + ' of ' + Math.floor(saved.duration / 60) + ':' + String(saved.duration % 60).padStart(2, '0'); copy.appendChild(progress);
    link.appendChild(copy); mount.appendChild(heading); mount.appendChild(link); mount.hidden = false;
})();
