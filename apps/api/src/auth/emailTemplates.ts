/**
 * Transactional email templates (05 §3.2).
 *
 * Email clients do not support CSS variables, external stylesheets or webfonts, so every
 * value is inline and built from the Algovyn brand tokens in docs/08. The text version is
 * sent alongside the HTML so a plain-text client still gets the code.
 */

import { BASE_PATH } from '@bikri/core';

const BRAND = {
  blue: '#006BB3',
  blueWash: '#F0F9FF',
  navy: '#182E55',
  teal: '#4BC2BF',
  page: '#F1F5F9',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  borderStrong: '#BAE6FD',
  text: '#0F172A',
  muted: '#475569',
  mutedSoft: '#64748B',
  warning: '#92400E',
  warningSoft: '#FEF3C7',
} as const;

const FONT =
  "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO =
  "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";
/** The site origin is fixed; the base path comes from the shared app paths (AGENTS.md). */
const SITE_HOST = 'algovyn.com';
const SITE_ORIGIN = `https://${SITE_HOST}`;
const SITE_URL = `${SITE_ORIGIN}${BASE_PATH}/`;
const SITE_LABEL = `${SITE_HOST}${BASE_PATH}`;
const LOGO_URL = `${SITE_URL}brand/bikri-pos-email.png`;

/** Escape user-controlled values before they reach an HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** UTC timestamp used in the invite email, e.g. `19 Nov 2026 09:40 UTC`. */
export function utcStamp(at: number): string {
  const date = new Date(at);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

function wordmark(): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 20px;">
      <tr>
        <td align="center">
          <img src="${LOGO_URL}" width="240" height="54" alt="Bikri POS" style="display:block;width:240px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;">
        </td>
      </tr>
    </table>`;
}

function eyebrow(text: string): string {
  return `<p style="margin:0 0 8px;font-family:${FONT};font-size:11px;line-height:14px;font-weight:700;letter-spacing:1.8px;text-transform:uppercase;color:${BRAND.blue};">${escapeHtml(text)}</p>`;
}

function heading(text: string): string {
  return `<h1 style="margin:0;font-family:${FONT};font-size:26px;line-height:34px;font-weight:700;letter-spacing:-0.4px;color:${BRAND.text};">${escapeHtml(text)}</h1>`;
}

function paragraph(html: string, marginTop = 10): string {
  return `<p style="margin:${marginTop}px 0 0;font-family:${FONT};font-size:15px;line-height:24px;color:${BRAND.muted};">${html}</p>`;
}

function codeCard(code: string, hint: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr>
        <td align="center" style="background:${BRAND.blueWash};border:1px solid ${BRAND.borderStrong};border-radius:14px;padding:20px 12px 16px;">
          <div style="font-family:${MONO};font-size:34px;line-height:38px;font-weight:700;letter-spacing:9px;padding-left:9px;color:${BRAND.navy};">${escapeHtml(code)}</div>
          <div style="margin-top:7px;font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.2px;color:${BRAND.muted};">${escapeHtml(hint)}</div>
        </td>
      </tr>
    </table>`;
}

function button(label: string, href: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr>
        <td align="center" bgcolor="${BRAND.blue}" style="border-radius:10px;">
          <a href="${escapeHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:15px;line-height:18px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>`;
}

function details(rows: { label: string; value: string }[]): string {
  const cells = rows
    .map(
      (row) => `
        <tr>
          <td style="padding:10px 0 0;font-family:${FONT};font-size:11px;line-height:16px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:${BRAND.mutedSoft};">${escapeHtml(row.label)}</td>
          <td align="right" style="padding:10px 0 0;font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${BRAND.text};">${escapeHtml(row.value)}</td>
        </tr>`,
    )
    .join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid ${BRAND.border};">
      ${cells}
    </table>`;
}

function securityNote(html: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
      <tr>
        <td style="background:${BRAND.warningSoft};border-radius:12px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${BRAND.warning};">
          ${html}
        </td>
      </tr>
    </table>`;
}

function document(input: { preheader: string; content: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Bikri</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.page};-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
    <div style="display:none;max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.page};">${escapeHtml(input.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.page};">
      <tr>
        <td align="center" style="padding:28px 16px 36px;">
          ${wordmark()}
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:18px;padding:32px;">
                <div style="width:44px;height:4px;margin:0 0 22px;background:${BRAND.teal};border-radius:2px;"></div>
                ${input.content}
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
            <tr>
              <td align="center" style="padding:20px 16px 0;font-family:${FONT};font-size:12px;line-height:19px;color:${BRAND.mutedSoft};">
                <p style="margin:0;font-weight:600;color:${BRAND.muted};">Bikri · Offline-first point of sale</p>
                <p style="margin:4px 0 0;"><a href="${SITE_URL}" style="color:${BRAND.blue};text-decoration:none;">${SITE_LABEL}</a></p>
                <p style="margin:10px 0 0;">You received this email because someone used this address at a Bikri shop. If that was not you, you can ignore it.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export function signinEmailHtml(input: {
  code: string;
  shopName: string;
  deviceName: string;
}): string {
  const shop = escapeHtml(input.shopName);
  const content = `
    ${eyebrow('Sign-in code')}
    ${heading('Your Bikri sign-in code')}
    ${paragraph(`Enter this code on the device that asked to sign in to <strong style="color:${BRAND.text};">${shop}</strong>.`)}
    ${codeCard(input.code, 'Expires in 10 minutes')}
    ${details([
      { label: 'Shop', value: input.shopName },
      { label: 'Device', value: input.deviceName },
    ])}
    ${securityNote(
      `<strong>Didn&rsquo;t request this?</strong> You can ignore this email. Nobody can sign in without this code, and Bikri will never ask you to share it.`,
    )}`;
  return document({
    preheader: `Your Bikri sign-in code expires in 10 minutes. Shop: ${input.shopName}.`,
    content,
  });
}

export function shopInviteEmailHtml(input: {
  shopName: string;
  code: string;
  link: string;
  expiresAt: number;
}): string {
  const shop = escapeHtml(input.shopName);
  const content = `
    ${eyebrow('Shop approved')}
    ${heading('Your shop is ready for Bikri')}
    ${paragraph(`Welcome, <strong style="color:${BRAND.text};">${shop}</strong>. Your shop has been approved. Open Bikri on the first till and enter the registration code to complete setup.`)}
    ${codeCard(input.code, 'Registration code')}
    ${button('Set up my shop', input.link)}
    ${details([
      { label: 'Shop', value: input.shopName },
      { label: 'Code expires', value: utcStamp(input.expiresAt) },
    ])}
    ${securityNote(
      `The first device you enrol becomes the admin device. If you did not ask for this shop, you can ignore this email and no setup will happen.`,
    )}`;
  return document({
    preheader: `${input.shopName} is approved for Bikri. Registration code inside.`,
    content,
  });
}
