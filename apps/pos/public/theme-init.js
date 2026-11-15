// Apply the chosen theme and language before the first paint. The shop DB is loaded later.
try {
  const theme = localStorage.getItem('bikri.theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#0e1014' : '#006BB3');
    }
  }
  const stored = localStorage.getItem('bikri.language');
  const language =
    stored === 'ur' ? 'ur' : stored === 'roman-ur' ? 'roman-ur' : 'en';
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'ur' ? 'rtl' : 'ltr';
} catch {
  /* storage may be disabled */
}
