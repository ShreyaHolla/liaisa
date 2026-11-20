// Owner dashboard: poll every 30 s and reload only when "Needs you" changed. Works without this file.
(function () {
  var dash = document.getElementById('dash');
  if (!dash || !window.fetch) return;
  var sig = dash.getAttribute('data-sig');
  setInterval(function () {
    if (document.hidden) return;
    fetch('/owner/api/summary', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && JSON.stringify(data.needsYou) !== sig) window.location.reload();
      })
      .catch(function () {});
  }, 30000);
})();
