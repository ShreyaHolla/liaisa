// Progressive enhancement for the contact form. Without JS the form posts normally
// and the server redirects back to /?contact=sent|error|limit#contact.
(function () {
  var form = document.getElementById('contact-form');
  var status = document.getElementById('contact-status');
  if (!form || !window.fetch) return;

  var FIELDS = ['name', 'email', 'message'];

  function clearErrors() {
    FIELDS.forEach(function (f) {
      var p = document.getElementById('error-' + f);
      var input = document.getElementById(f);
      p.hidden = true;
      p.textContent = '';
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    });
  }

  function show(text, tone) {
    status.hidden = false;
    status.textContent = text;
    status.className = 'notice notice-' + tone;
    status.setAttribute('role', tone === 'ok' ? 'status' : 'alert');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearErrors();
    status.hidden = true;
    var button = form.querySelector('button[type="submit"]');
    button.disabled = true;

    var payload = {};
    new FormData(form).forEach(function (value, key) {
      payload[key] = value;
    });

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { status: res.status, data: data };
        });
      })
      .then(function (r) {
        if (r.status === 200) {
          form.reset();
          show("Thanks for writing. We'll reply by email.", 'ok');
          return;
        }
        var error = (r.data && r.data.error) || {};
        var fields = error.fields || {};
        var first = null;
        FIELDS.forEach(function (f) {
          if (!fields[f]) return;
          var p = document.getElementById('error-' + f);
          var input = document.getElementById(f);
          p.textContent = fields[f];
          p.hidden = false;
          input.setAttribute('aria-invalid', 'true');
          input.setAttribute('aria-describedby', 'error-' + f);
          if (!first) first = input;
        });
        if (first) first.focus();
        else show(error.message || 'Something went wrong. Try again in a minute.', 'error');
      })
      .catch(function () {
        show('Something went wrong. Try again in a minute.', 'error');
      })
      .then(function () {
        button.disabled = false;
      });
  });
})();
