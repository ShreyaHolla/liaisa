// Progressive enhancement for /enquire. The page works without this file.
// Forms are posted with fetch and the next step is swapped in, so there is no reload.
(function () {
  var root = document.getElementById('enquire-root');
  if (!root || !window.fetch || !window.DOMParser) return;

  function sync() {
    var svc = root.querySelector('#service_id');
    var label = root.querySelector('#quantity-label');
    if (svc && label) {
      var opt = svc.options[svc.selectedIndex];
      label.textContent = (opt && opt.getAttribute('data-unit')) || 'Number of guests';
    }
    var checked = root.querySelector('input[name="channel"]:checked');
    root.querySelectorAll('[data-for]').forEach(function (el) {
      var show = !checked || el.getAttribute('data-for') === checked.value;
      el.hidden = !show;
      el.querySelectorAll('input').forEach(function (i) { i.disabled = !show; }); // hidden field isn't sent
    });
    var area = root.querySelector('textarea[data-count]');
    if (area) document.getElementById(area.getAttribute('data-count')).textContent = area.value.length;
  }

  root.addEventListener('change', sync);
  root.addEventListener('input', sync);

  root.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form.hasAttribute('data-enhance')) return;
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"]');
    var wait = form.querySelector('.wait');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Sending…';
    if (wait) wait.hidden = false;

    fetch(form.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: new URLSearchParams(new FormData(form)),
    })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var next = new DOMParser().parseFromString(html, 'text/html').getElementById('enquire-root');
        if (!next) throw new Error('no content');
        root.innerHTML = next.innerHTML;
        sync();
        var h = root.querySelector('[data-focus]');
        if (h) h.focus();
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = label;
        if (wait) { wait.textContent = 'That did not go through. Please try again.'; wait.hidden = false; }
      });
  });

  sync();
})();
