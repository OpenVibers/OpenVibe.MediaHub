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
            var response = await fetch('/api/v1/images/' + encodeURIComponent(discussion.dataset.comments) + '/comments?sort=old', { credentials: 'same-origin' });
            if (!response.ok) throw new Error('Comments could not be loaded.');
            var data = await response.json(); box.replaceChildren();
            function show(comment, parent) {
                var item = document.createElement('article');
                var text = document.createElement('p'); text.textContent = comment.deleted ? 'Comment removed' : comment.message; item.appendChild(text);
                (comment.attachments || []).forEach(function (file) {
                    if (!/^med_[0-9A-HJKMNP-TV-Z]{26}$/.test(file.id || '')) return;
                    var link = document.createElement('a'); link.href = 'https://openvibe.media/o/' + file.id;
                    link.textContent = file.name || 'Attached file'; link.rel = 'noopener noreferrer'; item.appendChild(link);
                });
                (comment.replies || []).forEach(function (reply) { show(reply, item); });
                parent.appendChild(item);
            }
            (data.comments || []).forEach(function (comment) { show(comment, box); });
            if (data.thread && /^cth_[A-Za-z0-9_-]+$/.test(data.thread.id || '')) {
                var link = document.createElement('a'); link.href = 'https://openvibe.community/c/' + encodeURIComponent(data.thread.id);
                link.textContent = 'Join the discussion on Community'; box.appendChild(link);
            }
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
