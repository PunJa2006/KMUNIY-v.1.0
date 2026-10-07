// Apply the last selected theme before the page is painted.
try {
  document.documentElement.lang = localStorage.getItem('community-language') === 'en' ? 'en' : 'th';
  document.documentElement.dataset.theme = localStorage.getItem('community-last-theme') === 'dark' ? 'dark' : 'light';
} catch {}
