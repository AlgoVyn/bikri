/**
 * Shop admin calls from an admin device (04 §3.8, 05 §3.2): `X-Bikri-Staff` plus the 12-hour
 * owner session from email sign-in. The session lives in memory only and is dropped on Lock.
 */
import type { BikriDb } from '@bikri/db';
import { create } from 'zustand';
import { useSession } from '../state/session.ts';
import { type RequestOptions, SyncHttpError, tillRequest } from './client.ts';

type OwnerSessionState = {
  token: string | null;
  expiresAt: number;
  staffId: string | null;
  set: (token: string, expiresAt: number, staffId: string) => void;
  clear: () => void;
};

export const useOwnerSession = create<OwnerSessionState>((set) => ({
  token: null,
  expiresAt: 0,
  staffId: null,
  set: (token, expiresAt, staffId) => set({ token, expiresAt, staffId }),
  clear: () => set({ token: null, expiresAt: 0, staffId: null }),
}));

// Lock and Switch user end the owner session (screens/17).
useSession.subscribe((s, prev) => {
  if (prev.session && s.session?.staff_id !== prev.session.staff_id)
    useOwnerSession.getState().clear();
});

export function ownerSessionValid(staffId: string, now = Date.now()): boolean {
  const s = useOwnerSession.getState();
  return Boolean(s.token) && s.staffId === staffId && s.expiresAt > now;
}

export class OwnerSigninRequired extends Error {
  constructor() {
    super('Confirm it is you first');
    this.name = 'OwnerSigninRequired';
  }
}

/** A `/api/shop/*` call as `staffId`; throws OwnerSigninRequired when the session is missing. */
export async function shopRequest<T>(
  db: BikriDb,
  staffId: string,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const s = useOwnerSession.getState();
  const headers: Record<string, string> = {
    'x-bikri-staff': staffId,
    ...(options.headers ?? {}),
  };
  if (s.token && s.staffId === staffId)
    headers['x-bikri-owner-session'] = s.token;
  try {
    return await tillRequest<T>(db, `/shop${path}`, { ...options, headers });
  } catch (e) {
    if (e instanceof SyncHttpError && e.code === 'OWNER_SIGNIN_REQUIRED') {
      useOwnerSession.getState().clear();
      throw new OwnerSigninRequired();
    }
    throw e;
  }
}

export type SigninStart = {
  code_id: string;
  expires_at: number;
  email_hint: string;
};

export function startOwnerSignin(db: BikriDb, staffId: string) {
  return shopRequest<SigninStart>(db, staffId, '/owner-signin/start', {
    method: 'POST',
    json: {},
  });
}

const URDU_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Urdu and Arabic-Indic digits → ASCII; other characters dropped; max 6 (screens/17). */
export function normaliseSigninCode(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const u = URDU_DIGITS.indexOf(ch);
    const a = ARABIC_DIGITS.indexOf(ch);
    if (u >= 0) out += String(u);
    else if (a >= 0) out += String(a);
    else if (ch >= '0' && ch <= '9') out += ch;
  }
  return out.slice(0, 6);
}

export async function verifyOwnerSignin(
  db: BikriDb,
  staffId: string,
  codeId: string,
  code: string,
): Promise<void> {
  const res = await shopRequest<{ session: string; expires_at: number }>(
    db,
    staffId,
    '/owner-signin/verify',
    {
      method: 'POST',
      json: { code_id: codeId, code: normaliseSigninCode(code) },
    },
  );
  useOwnerSession.getState().set(res.session, res.expires_at, staffId);
}
