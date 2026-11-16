/* A font file's specimen on openvibe.download (2026-11-16, "fonts and icons and all that"): the font is read from the
 * drive's own /files/:id/font and set on the sample with the CSS Font Loading API, so the sample shows the font itself.
 * Without it the sample stays in the page's font and says so. */
(function () {
    'use strict';
    var boxes = document.querySelectorAll('[data-font]');
    Array.prototype.forEach.call(boxes, function (el, i) {
        if (typeof FontFace !== 'function' || !document.fonts) { el.classList.add('is-failed'); return; }
        var family = 'ovdl-font-' + i;
        var face = new FontFace(family, 'url("' + el.getAttribute('data-font') + '")');
        face.load().then(function (f) {
            document.fonts.add(f);
            el.style.fontFamily = '"' + family + '", system-ui, sans-serif';
            el.classList.add('is-loaded');
        }).catch(function () { el.classList.add('is-failed'); });
    });
})();
