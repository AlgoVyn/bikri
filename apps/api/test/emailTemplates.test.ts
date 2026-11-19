import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  shopInviteEmailHtml,
  signinEmailHtml,
  utcStamp,
} from '../src/auth/emailTemplates.ts';
import { shopInviteEmailText, signinEmailText } from '../src/auth/mailer.ts';

const ARABIC_SCRIPT = /[\u0600-\u06FF]/u;

describe('transactional email templates', () => {
  it('escapes user-controlled values', () => {
    const html = signinEmailHtml({
      code: '482913',
      shopName: 'Algovyn <Mobiles> & Co',
      deviceName: 'Counter "A"',
    });
    expect(escapeHtml(`<b>&"'</b>`)).toBe(
      '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;',
    );
    expect(html).toContain('Algovyn &lt;Mobiles&gt; &amp; Co');
    expect(html).toContain('Counter &quot;A&quot;');
    expect(html).not.toContain('<Mobiles>');
  });

  it('renders one large code and the expiry in English only', () => {
    const html = signinEmailHtml({
      code: '482913',
      shopName: 'Algovyn Mobiles',
      deviceName: 'Counter 1',
    });
    expect(html).toContain('482913');
    expect(html).toContain('Expires in 10 minutes');
    expect(html).toContain('Algovyn Mobiles');
    expect(html).toContain('Counter 1');
    expect(html).toContain(
      'https://algovyn.com/bikri/brand/bikri-pos-email.png',
    );
    expect(html).toContain('alt="Bikri POS"');
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(ARABIC_SCRIPT);
  });

  it('renders the invite button and escapes the link', () => {
    const html = shopInviteEmailHtml({
      shopName: 'Algovyn Mobiles',
      code: 'ABCD-2345',
      link: 'https://algovyn.com/bikri/enrol?code=ABCD-2345&shop=1',
      expiresAt: Date.UTC(2026, 10, 19, 9, 40),
    });
    expect(html).toContain(
      'https://algovyn.com/bikri/enrol?code=ABCD-2345&amp;shop=1',
    );
    expect(html).toContain('Set up my shop');
    expect(html).toContain('ABCD-2345');
    expect(html).toContain('19 Nov 2026 09:40 UTC');
    expect(html).not.toMatch(ARABIC_SCRIPT);
  });

  it('keeps the plain-text alternatives English-only', () => {
    const signin = signinEmailText({
      code: '482913',
      shopName: 'Algovyn Mobiles',
      deviceName: 'Counter 1',
    });
    expect(signin).toContain('Your Bikri sign-in code is 482913');
    expect(signin).not.toMatch(ARABIC_SCRIPT);

    const invite = shopInviteEmailText({
      shopName: 'Algovyn Mobiles',
      code: 'ABCD-2345',
      link: 'https://algovyn.com/bikri/enrol?code=ABCD-2345',
      expiresAt: Date.UTC(2026, 10, 19, 9, 40),
    });
    expect(invite).toContain('Registration code: ABCD-2345');
    expect(invite).not.toMatch(ARABIC_SCRIPT);
  });

  it('formats the invite expiry in UTC', () => {
    expect(utcStamp(Date.UTC(2026, 10, 19, 9, 40))).toBe(
      '19 Nov 2026 09:40 UTC',
    );
  });
});
