// Sets light or dark mode before the page paints. A saved choice wins; otherwise follow the device.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('theme'); } catch (e) { /* storage blocked */ }
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function apply() {
    var t = saved === 'light' || saved === 'dark' ? saved : (mq && mq.matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
  }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!saved) apply(); });
})();
