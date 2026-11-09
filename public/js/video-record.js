/* Record on this page with OpenVibe.Cam, then give its File to Video's ordinary chunked upload form. */
(function () {
    'use strict';
    var form = document.querySelector('form[data-video-record]');
    if (!form) return;
    var status = form.querySelector('[role=status]');
    var fileInput = form.querySelector('input[name=file]');
    var buttons = form.querySelectorAll('[data-record-open]');
    function say(text) { if (status) status.textContent = text; }
    Array.prototype.forEach.call(buttons, function (button) {
        button.addEventListener('click', async function () {
            if (!window.OpenVibeCam || !window.DataTransfer) { say('The camera is unavailable in this browser. You can upload a file instead.'); return; }
            button.disabled = true;
            try {
                var result = await window.OpenVibeCam.open({ mode: button.getAttribute('data-record-open'), maxSeconds: 600 });
                if (!result) { say('Recording cancelled.'); return; }
                var transfer = new DataTransfer(); transfer.items.add(result.file); fileInput.files = transfer.files;
                say('Uploading your clip…');
                form.requestSubmit();
            } catch (err) { say(err.message || 'The camera could not open.'); }
            finally { button.disabled = false; }
        });
    });
})();
