// "Read my approvals": reads the pending approvals aloud with the browser's own speechSynthesis.
// Nothing is sent to a server. The button is hidden unless the browser supports speech.
(function (root) {
  var ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
    'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function below100(n) {
    if (n < 20) return ONES[n];
    return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '');
  }
  function below1000(n) {
    var h = Math.floor(n / 100);
    var rest = n % 100;
    return (h ? ONES[h] + ' hundred' + (rest ? ' ' : '') : '') + (rest ? below100(rest) : '');
  }
  /** 18900 -> "eighteen thousand nine hundred"; Indian grouping (thousand, lakh, crore). */
  function numberToWords(n) {
    n = Math.floor(Number(n) || 0);
    if (n === 0) return 'zero';
    var parts = [];
    var units = [[10000000, 'crore'], [100000, 'lakh'], [1000, 'thousand']];
    for (var i = 0; i < units.length; i += 1) {
      var q = Math.floor(n / units[i][0]);
      if (q) { parts.push(numberToWords(q) + ' ' + units[i][1]); n %= units[i][0]; }
    }
    if (n) parts.push(below1000(n));
    return parts.join(' ');
  }
  function rupeesInWords(n) {
    return numberToWords(n) + (Math.floor(n) === 1 ? ' rupee' : ' rupees');
  }

  /** One spoken paragraph per approval. */
  function describe(item, index, count) {
    var bits = ['Item ' + (index + 1) + ' of ' + count + '.', item.customer + '.'];
    var what = [item.service, item.quantity ? item.quantity + (item.unit ? ' ' + item.unit : '') : ''].filter(Boolean).join(', ');
    if (what) bits.push(what + (item.date ? ', on ' + item.date : '') + '.');
    else if (item.date) bits.push('On ' + item.date + '.');
    bits.push('Total: ' + rupeesInWords(item.total) + '.');
    bits.push(item.warnings.length ? 'Warning' + (item.warnings.length > 1 ? 's' : '') + ': ' + item.warnings.join(' ') : 'No warnings.');
    return bits.join(' ');
  }
  /** The count first, then each item. */
  function script(items) {
    if (!items.length) return ['Nothing is waiting for your approval.'];
    var lines = ['You have ' + numberToWords(items.length) + ' approval' + (items.length === 1 ? '' : 's') + ' waiting.'];
    items.forEach(function (item, i) { lines.push(describe(item, i, items.length)); });
    return lines;
  }

  function readItems(doc) {
    var nodes = doc.querySelectorAll('[data-approval]');
    var items = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var warnings = [];
      try { warnings = JSON.parse(el.getAttribute('data-warnings') || '[]'); } catch (e) { warnings = []; }
      items.push({
        customer: el.getAttribute('data-customer') || '', service: el.getAttribute('data-service') || '', quantity: el.getAttribute('data-qty') || '',
        unit: el.getAttribute('data-unit') || '', date: el.getAttribute('data-date') || '', total: Number(el.getAttribute('data-total')) || 0, warnings: warnings,
      });
    }
    return items;
  }

  function init(win, doc) {
    var box = doc && doc.getElementById('briefing');
    if (!box) return false;
    var synth = win.speechSynthesis;
    if (!synth || typeof win.SpeechSynthesisUtterance !== 'function') return false; // stays hidden
    box.hidden = false;
    var start = doc.getElementById('briefing-start');
    var pause = doc.getElementById('briefing-pause');
    var stop = doc.getElementById('briefing-stop');
    var paused = false;

    function idle() {
      paused = false;
      start.hidden = false;
      pause.hidden = true;
      stop.hidden = true;
      pause.textContent = 'Pause';
    }
    start.addEventListener('click', function () {
      synth.cancel();
      var lines = script(readItems(doc));
      lines.forEach(function (text, i) {
        var u = new win.SpeechSynthesisUtterance(text);
        u.lang = 'en-IN';
        if (i === lines.length - 1) u.onend = idle;
        synth.speak(u);
      });
      start.hidden = true;
      pause.hidden = false;
      stop.hidden = false;
    });
    pause.addEventListener('click', function () {
      if (paused) { synth.resume(); paused = false; pause.textContent = 'Pause'; } else { synth.pause(); paused = true; pause.textContent = 'Resume'; }
    });
    stop.addEventListener('click', function () { synth.cancel(); idle(); });
    return true;
  }

  root.LiaisaBriefing = { numberToWords: numberToWords, rupeesInWords: rupeesInWords, script: script, init: init };
  if (root.document && root.document.getElementById) init(root, root.document);
})(typeof window !== 'undefined' ? window : this);
