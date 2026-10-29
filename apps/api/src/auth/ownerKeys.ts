import { ApiError } from '../errors.ts';

/** Owner sessions and sign-in codes must never be signed with the literal string "undefined". */
function required(value: unknown, name: string): string {
  const key = String(value ?? '');
  if (key.length < 16 || key === 'undefined')
    throw new ApiError(
      'SERVER_MISCONFIGURED',
      503,
      `${name} is missing or too short`,
    );
  return key;
}

export function ownerSessionKey(env: Env): string {
  return required(env.OWNER_SESSION_KEY, 'OWNER_SESSION_KEY');
}

export function ownerCodeKey(env: Env): string {
  return required(env.OWNER_CODE_KEY, 'OWNER_CODE_KEY');
}
