import type { MiddlewareHandler } from 'hono';
import { verifyAccessJwt } from '../auth/access.ts';
import { ApiError } from '../errors.ts';

export type OperatorVars = { operator: string };

export function operatorEmails(env: Env): string[] {
  return String(env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** Cloudflare Access for /api/admin/* (05 §3.1). A device token is never accepted here. */
export const accessAuth: MiddlewareHandler<{
  Bindings: Env;
  Variables: OperatorVars;
}> = async (c, next) => {
  let email: string | null = null;
  if (String(c.env.ENV) === 'test' && c.env.ACCESS_TEST_EMAIL) {
    email =
      c.req.header('x-test-access-email')?.toLowerCase() ??
      c.env.ACCESS_TEST_EMAIL.toLowerCase();
  } else {
    const jwt = c.req.header('cf-access-jwt-assertion');
    if (jwt) {
      email = await verifyAccessJwt(jwt, {
        teamDomain: String(c.env.ACCESS_TEAM_DOMAIN),
        aud: c.env.ACCESS_AUD ?? '',
      });
    }
  }
  if (!email)
    throw new ApiError(
      'UNAUTHENTICATED',
      401,
      'Sign in with Cloudflare Access',
    );
  if (!operatorEmails(c.env).includes(email))
    throw new ApiError('FORBIDDEN', 403, 'Not an operator');
  c.set('operator', email);
  await next();
};
