// Click/keyboard-to-copy for any element with class "copy" + data-copy attribute.
// Block-level copy targets (<pre>, <p>) carry role="button" tabindex="0" so they're
// keyboard-focusable and Enter/Space-activatable — a native <button> can't wrap block
// content. Falls back gracefully if the Clipboard API isn't available.
(function () {
  var statusTimer = null;
  function announce(msg) {
    var status = document.getElementById('copy-status');
    if (!status) return;
    status.textContent = msg;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { status.textContent = ''; }, 1600);
  }
  function copyFrom(el) {
    var text = el.getAttribute('data-copy') || el.textContent;
    var done = function () {
      el.classList.add('copied');
      announce('Copied to clipboard');
      setTimeout(function () { el.classList.remove('copied'); }, 1600);
    };
    var fail = function () { announce('Copy failed'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        legacyCopy(text, done, fail);
      });
    } else {
      legacyCopy(text, done, fail);
    }
  }
  function legacyCopy(text, done, fail) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    var prev = document.activeElement;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    if (prev && typeof prev.focus === 'function') prev.focus();
    if (ok) { done(); } else { fail(); }
  }
  document.addEventListener('click', function (e) {
    var el = e.target.closest('.copy');
    if (el) copyFrom(el);
  });
  document.addEventListener('keydown', function (e) {
    if (e.repeat) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var el = e.target.closest('.copy');
    if (!el) return;
    // Native <button> already activates on Enter/Space — don't double-fire.
    if (el.tagName === 'BUTTON') return;
    e.preventDefault();
    copyFrom(el);
  });
})();
