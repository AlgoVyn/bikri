// Apply the chosen theme before the first paint. The shop DB is loaded later.
try {
  const stored = localStorage.getItem('bikri.theme');
  const systemDark =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = stored === 'dark' || (stored !== 'light' && systemDark);
  const root = document.documentElement;
  if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;
  // Mantine reads this attribute before React mounts, which avoids a colour flash.
  root.dataset.mantineColorScheme = dark ? 'dark' : 'light';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0f172a' : '#006BB3');
} catch {
  /* storage may be disabled */
}
