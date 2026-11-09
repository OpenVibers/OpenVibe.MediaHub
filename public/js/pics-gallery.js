/* Public gallery: progressive loading and explicit, authenticated likes. */
(function () {
    'use strict';
    var next = document.querySelector('[data-gallery-next]'), grid = document.querySelector('[data-gallery]'), busy = false;
    async function more(event) {
        if (event) event.preventDefault();
        if (busy || !next) return;
        busy = true;
        var status = document.querySelector('[data-gallery-status]');
        try {
            var response = await fetch(next.href, { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Could not load pictures. Use More pictures to try again.');
            var doc = new DOMParser().parseFromString(await response.text(), 'text/html');
            doc.querySelectorAll('[data-gallery] > article').forEach(function (card) { grid.appendChild(document.importNode(card, true)); });
            var link = doc.querySelector('[data-gallery-next]');
            if (link) next.href = link.href; else { next.remove(); next = null; }
            status.textContent = 'More pictures loaded.';
        } catch (error) { status.textContent = error.message; }
        finally { busy = false; }
    }
    if (next) {
        next.addEventListener('click', more);
        if ('IntersectionObserver' in window) new IntersectionObserver(function (entries) { if (entries[0].isIntersecting) more(); }, { rootMargin: '300px' }).observe(next);
    }
    var discussion = document.querySelector('[data-comments]');
    if (discussion) discussion.addEventListener('click', async function () {
        var box = document.querySelector('[data-comments-list]'); discussion.disabled = true;
        try {
            var response = await fetch('https://openvibe.community/api/v1/comments/threads/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref: { service: 'pics', type: 'picture', id: discussion.dataset.comments } }) });
            if (!response.ok) throw new Error('Discussion is unavailable. Try again later.');
            var result = await response.json(), thread = result.thread;
            if (!thread || !/^cth_[A-Za-z0-9_-]+$/.test(thread.id)) throw new Error('Discussion is unavailable.');
            var listing = await fetch('https://openvibe.community/api/v1/comments/threads/' + encodeURIComponent(thread.id));
            if (!listing.ok) throw new Error('Comments could not be loaded.');
            var data = await listing.json(); box.replaceChildren();
            (data.comments || []).forEach(function (comment) { var p = document.createElement('p'); p.textContent = comment.message; box.appendChild(p); });
            var link = document.createElement('a'); link.href = 'https://openvibe.community/c/' + encodeURIComponent(thread.id); link.textContent = 'Join the discussion on Community'; box.appendChild(link);
        } catch (error) { box.textContent = error.message; }
        finally { discussion.disabled = false; }
    });
    var like = document.querySelector('[data-like]');
    if (like) like.addEventListener('click', async function () {
        like.disabled = true;
        var status = document.querySelector('[data-like-status]');
        try {
            var removing = like.getAttribute('aria-pressed') === 'true';
            var response = await fetch('/api/v1/images/' + encodeURIComponent(like.dataset.like) + '/like', { method: removing ? 'DELETE' : 'PUT', credentials: 'same-origin' });
            if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to like this picture.' : 'Could not update your like. Try again.');
            var data = await response.json();
            document.querySelector('[data-like-count]').textContent = data.likes;
            like.setAttribute('aria-pressed', String(!removing));
            var word = like.querySelector('[data-like-word]'); if (word) word.textContent = removing ? 'Like' : 'Liked'; else like.textContent = removing ? 'Like' : 'Liked';
            status.textContent = '';
        } catch (error) { status.textContent = error.message; }
        finally { like.disabled = false; }
    });
})();
