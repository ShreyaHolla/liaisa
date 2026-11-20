// Progressive enhancement for the owner area. Everything works without this file.
(function () {
  // Confirm dialog for forms whose button has data-confirm (DESIGN §4.5).
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

  // Double-submit protection: the server is idempotent too.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.method === 'dialog') return;
    setTimeout(function () {
      form.querySelectorAll('button[type="submit"]').forEach(function (b) { b.disabled = true; });
    }, 0);
  });

  // Dashboard: poll every 30 s; reload only when "Needs you" changed.
  var dash = document.getElementById('dash');
  if (dash && window.fetch) {
    var sig = dash.getAttribute('data-sig');
    setInterval(function () {
      fetch('/owner/api/summary', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && JSON.stringify(data.needsYou) !== sig) window.location.reload();
        })
        .catch(function () {});
    }, 30000);
  }
})();
