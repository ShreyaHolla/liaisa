// Copy button for the "Share your enquiry link" card. Without this file the link is still in a
// read-only field the owner can select, and the WhatsApp and Download QR links are plain links.
(function (root) {
  function say(doc, text) {
    var status = doc.querySelector('[data-copy-status]');
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
  }

  /** Copies the field's value. navigator.clipboard when available, else select the text and execCommand. */
  function copy(win, doc, input) {
    function fallback() {
      input.focus();
      input.select();
      if (input.setSelectionRange) input.setSelectionRange(0, 99999);
      var ok = false;
      try { ok = Boolean(doc.execCommand && doc.execCommand('copy')); } catch (e) { ok = false; }
      say(doc, ok ? 'Link copied.' : 'The link is selected. Press Ctrl+C (or Copy) to copy it.');
    }
    var clip = win.navigator && win.navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(input.value).then(function () { say(doc, 'Link copied.'); }, fallback);
    } else {
      fallback();
    }
  }

  function init(win, doc) {
    var buttons = doc.querySelectorAll('[data-copy]');
    for (var i = 0; i < buttons.length; i += 1) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var input = doc.getElementById(btn.getAttribute('data-copy'));
          if (input) copy(win, doc, input);
        });
      })(buttons[i]);
    }
  }

  root.LiaisaShare = { copy: copy, init: init };
  if (root.document && root.document.querySelectorAll) init(root, root.document);
})(typeof window !== 'undefined' ? window : this);
