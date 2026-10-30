import { expect, test } from '@playwright/test';

// The app shell must stay compatible with `script-src 'self'` (D-036, D-149).
test('the theme pre-paint is external and runs under the strict script CSP', async ({
  page,
  request,
}) => {
  const shell = await request.get('/bikri/');
  expect(shell.ok()).toBe(true);
  const csp = shell.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

  const html = await shell.text();
  expect(html).toContain('<script src="/bikri/theme-init.js"></script>');
  const inline = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
  ].filter((match) => {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    return !/\bsrc\s*=/i.test(attrs) && body.trim() !== '';
  });
  expect(inline).toEqual([]);

  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });
  await page.addInitScript(() => localStorage.setItem('bikri.theme', 'dark'));
  // Stop the app module: the theme must already be applied by theme-init.js.
  await page.route('**/bikri/assets/index-*.js', (route) => route.abort());
  await page.goto('/bikri/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(violations).toEqual([]);
});
