// Shared enhancements. Everything works without this file (plain forms, plain links).
(function () {
  document.documentElement.classList.add('js');
  // Confirm dialog for buttons with data-confirm (DESIGN §4.5).
  var dialog = document.getElementById('confirm-dialog');
  var pending = null;
  if (dialog && dialog.showModal) {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-confirm]') : null;
      if (!btn) return;
      e.preventDefault();
      pending = btn;
      document.getElementById('confirm-text').textContent = btn.getAttribute('data-confirm');
      document.getElementById('confirm-ok').textContent = btn.getAttribute('data-confirm-label') || btn.textContent;
      dialog.showModal();
    });
    dialog.addEventListener('close', function () {
      var btn = pending;
      pending = null;
      if (dialog.returnValue === 'ok' && btn && btn.form) {
        btn.removeAttribute('data-confirm');
        btn.form.requestSubmit(btn);
      } else if (btn) {
        btn.focus();
      }
      dialog.returnValue = '';
    });
  }

  // Bottom sheets: <button data-sheet="id"> opens <dialog id="id">; a [data-close] button closes it.
  document.addEventListener('click', function (e) {
    var open = e.target.closest ? e.target.closest('[data-sheet]') : null;
    if (open) {
      var sheet = document.getElementById(open.getAttribute('data-sheet'));
      if (sheet && sheet.showModal) {
        e.preventDefault();
        sheet.showModal();
        var field = sheet.querySelector('textarea, input:not([type="hidden"])');
        if (field) field.focus();
      }
      return;
    }
    var close = e.target.closest ? e.target.closest('[data-close]') : null;
    if (close) {
      var d = close.closest('dialog');
      if (d) { e.preventDefault(); d.close(); }
    }
  });

  // Links like <a href="#ask" data-open="ask"> open an inline <details> and focus its field.
  function openDetails(id) {
    var el = id && document.getElementById(id);
    if (!el || el.tagName !== 'DETAILS') return;
    el.open = true;
    var field = el.querySelector('textarea, input:not([type="hidden"]):not([type="checkbox"])');
    if (field) field.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center' });
  }
  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('a[data-open]') : null;
    if (a) { e.preventDefault(); openDetails(a.getAttribute('data-open')); }
  });
  if (location.hash) openDetails(location.hash.slice(1));

  // Pause or play a looping animation: <button data-toggle-anim="id"> toggles .is-paused on that element.
  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-toggle-anim]') : null;
    if (!b) return;
    var target = document.getElementById(b.getAttribute('data-toggle-anim'));
    if (!target) return;
    var paused = target.classList.toggle('is-paused');
    b.setAttribute('aria-pressed', paused ? 'true' : 'false');
    b.textContent = paused ? 'Play animation' : 'Pause animation';
  });

  // "Sending…" on submit buttons, and no double submits (the server is idempotent too).
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.method === 'dialog' || form.hasAttribute('data-enhance')) return;
    setTimeout(function () {
      form.setAttribute('data-busy', '');
      form.querySelectorAll('button[type="submit"]:not([data-no-busy])').forEach(function (b) {
        if (b.disabled) return;
        if (!b.querySelector('.busy')) {
          b.setAttribute('data-label', b.textContent);
          b.textContent = 'Sending…';
        }
        b.disabled = true;
      });
    }, 0);
  });
  // Coming back with the browser's back button: undo the busy state.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    document.querySelectorAll('form[data-busy]').forEach(function (f) {
      f.removeAttribute('data-busy');
      f.querySelectorAll('button[type="submit"]').forEach(function (b) {
        if (b.hasAttribute('data-label')) b.textContent = b.getAttribute('data-label');
        b.disabled = false;
      });
    });
  });
})();
