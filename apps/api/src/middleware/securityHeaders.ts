import { securityHeaderEntries } from '@bikri/core';
import type { MiddlewareHandler } from 'hono';

type HeaderSetter = {
  header: (name: string, value: string) => void;
};

export function applySecurityHeaders(c: HeaderSetter): void {
  for (const [name, value] of securityHeaderEntries()) {
    c.header(name, value);
  }
}

export const securityHeaders: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  await next();
  applySecurityHeaders(c);
};
