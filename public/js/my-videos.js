/* Video's /me/videos: the shared progress meter on an upload that stopped part-way, and a kit sheet for Delete.
 * Nothing here asks the browser for a confirm: the sheet is the site's own <dialog>, and its form posts as before. */
(function () {
    'use strict';
    var kit = window.OVUpload;
    Array.prototype.forEach.call(document.querySelectorAll('[data-ov-upload-progress]'), function (el) {
        if (!kit || !kit.progress) return;
        var meter = kit.progress(el, { compact: true });
        meter.update({
            state: el.getAttribute('data-state') || 'waiting',
            done: Number(el.getAttribute('data-done')) || 0,
            total: Number(el.getAttribute('data-total')) || 0
        });
        meter.destroy();   // the page is a snapshot: the row is not sending here
    });
    var sheet = document.querySelector('[data-delete-sheet]');
    if (!sheet) return;
    var form = sheet.querySelector('[data-delete-form]');
    var message = sheet.querySelector('[data-delete-message]');
    document.addEventListener('click', function (event) {
        var button = event.target.closest && event.target.closest('[data-delete-video]');
        if (button) {
            if (form) form.action = '/u/' + encodeURIComponent(button.getAttribute('data-delete-video')) + '/delete';
            if (message) message.textContent = '“' + (button.getAttribute('data-delete-title') || 'This video') + '” and its file are removed from OpenVibe.Media. This cannot be undone.';
            if (typeof sheet.showModal === 'function') sheet.showModal(); else sheet.setAttribute('open', '');
            return;
        }
        if (event.target.closest && event.target.closest('[data-delete-cancel]')) {
            if (typeof sheet.close === 'function') sheet.close(); else sheet.removeAttribute('open');
        }
    });
})();
