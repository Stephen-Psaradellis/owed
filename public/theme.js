// Applied before first paint: the saved theme (if any) and the matching Bryntum theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('owed-theme');
  } catch (e) {
    saved = null;
  }
  var dark = saved ? saved === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  var link = document.getElementById('bryntum-theme');
  if (link && dark) link.href = '/build/bryntum-dark.css';
})();
