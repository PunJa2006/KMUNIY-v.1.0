// Choose the theme before the page is painted.
(() => {
  let savedTheme;
  try {
    document.documentElement.lang = localStorage.getItem('community-language') === 'en' ? 'en' : 'th';
    savedTheme = localStorage.getItem('community-last-theme');
  } catch {}
  let systemTheme = 'light';
  try {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) systemTheme = 'dark';
  } catch {}
  document.documentElement.dataset.theme = ['light', 'dark'].includes(savedTheme) ? savedTheme : systemTheme;
})();
