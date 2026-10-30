// Apply the chosen theme before the first paint. The shop DB is loaded later.
try {
  const theme = localStorage.getItem('bikri.theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      meta.setAttribute('content', theme === 'dark' ? '#0f172a' : '#006BB3');
    }
  }
} catch {
  /* storage may be disabled */
}
