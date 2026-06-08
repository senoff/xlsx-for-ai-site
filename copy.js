// Click-to-copy for any element with class "copy" + data-copy attribute.
// Falls back gracefully if Clipboard API isn't available.
document.addEventListener('click', function (e) {
  var el = e.target.closest('.copy');
  if (!el) return;
  var text = el.getAttribute('data-copy') || el.innerText;
  var done = function () {
    el.classList.add('copied');
    setTimeout(function () { el.classList.remove('copied'); }, 1600);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () {
      // permission denied / not supported — fall through to legacy
      legacyCopy(text, done);
    });
  } else {
    legacyCopy(text, done);
  }
});
function legacyCopy(text, done) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch (_) {}
  document.body.removeChild(ta);
}
