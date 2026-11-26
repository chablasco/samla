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
  // Scroll animations are only switched on when scripts run, so the page is always readable without them.
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var root = document.documentElement;
  if (!still && 'IntersectionObserver' in window) {
    root.classList.add('motion');
    // Safety: if the page script never starts, show everything instead of leaving it hidden.
    setTimeout(function () { if (!root.classList.contains('motion-ready')) root.classList.remove('motion'); }, 3000);
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { if (!saved) apply(); });
})();
