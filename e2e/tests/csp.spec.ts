import { expect, test } from '@playwright/test';

// The app shell must stay compatible with a nonce-free `script-src` (D-036, D-149).
test('the theme pre-paint is inline under a CSP hash', async ({
  page,
  request,
}) => {
  const shell = await request.get('/bikri/');
  expect(shell.ok()).toBe(true);
  const csp = shell.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");

  const html = await shell.text();
  const inline = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
  ].filter((match) => {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    return !/\bsrc\s*=/i.test(attrs) && body.trim() !== '';
  });
  expect(inline).toHaveLength(1);
  expect(csp).toMatch(/'sha256-[A-Za-z0-9+/=]+'/u);

  const violations: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) {
      violations.push(message.text());
    }
  });
  await page.addInitScript(() => localStorage.setItem('bikri.theme', 'dark'));
  // Stop the app module: the theme must already be applied by the inline script.
  await page.route('**/bikri/assets/index-*.js', (route) => route.abort());
  await page.goto('/bikri/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(violations).toEqual([]);
});
