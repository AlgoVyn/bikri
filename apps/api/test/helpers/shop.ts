import { testOutbox } from '../../src/auth/mailer.ts';
import { api, IDS, json, type Shop } from './fixtures.ts';

let ip = 0;
export function nextIp(): string {
  ip += 1;
  return `10.0.${Math.floor(ip / 250)}.${ip % 250}`;
}

export function ownerHeaders(
  staff: string = IDS.owner,
  session?: string,
): Record<string, string> {
  return {
    'x-bikri-staff': staff,
    'cf-connecting-ip': nextIp(),
    ...(session ? { 'x-bikri-owner-session': session } : {}),
  };
}

/** The 6-digit code of the last email sent to `to`. */
export function lastCode(to: string): string {
  const m = [...testOutbox].reverse().find((x) => x.to === to);
  return m?.text.match(/\b(\d{6})\b/)?.[1] ?? '';
}

export async function startSignin(shop: Shop, token = shop.admin.token) {
  return api('/shop/owner-signin/start', {
    method: 'POST',
    token,
    headers: ownerHeaders(),
  });
}

/** Full sign-in on the shop's admin device; returns the owner session. */
export async function ownerSession(shop: Shop, email: string): Promise<string> {
  const start = await json<{ code_id: string }>(await startSignin(shop));
  const res = await api('/shop/owner-signin/verify', {
    method: 'POST',
    token: shop.admin.token,
    headers: ownerHeaders(),
    json: { code_id: start.code_id, code: lastCode(email) },
  });
  const body = await json<{ session: string }>(res);
  return body.session;
}

export function shopApi(
  shop: Shop,
  session: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
) {
  return api(path, {
    ...init,
    token: shop.admin.token,
    headers: {
      ...ownerHeaders(IDS.owner, session),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}
