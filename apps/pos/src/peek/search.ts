import { parsePeekTarget, peekValue } from './peek.ts';

export type PeekSearch = { peek?: string };

/** Route search schema shared by the record pages that can host a reference peek. */
export function peekSearch(search: Record<string, unknown>): PeekSearch {
  const target = parsePeekTarget(search.peek);
  return { peek: target === null ? undefined : peekValue(target) };
}
