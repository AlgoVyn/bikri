/** Types for the dependency-free measurement script used by tools/seed/large.ts. */
export type FixtureRow = { id: string; [key: string]: unknown };
export function parseArgs(argv: string[]): Record<string, unknown>;
export function bytes(db: unknown): number;
export function isoDate(at: number): string;
export function productRow(
  tenant: string,
  index: number,
  now: number,
): FixtureRow;
export function customerRow(
  tenant: string,
  index: number,
  now: number,
): FixtureRow;
export function saleRows(
  tenant: string,
  bill: number,
  products: string[],
  customer: string | undefined,
  day: number,
): Record<string, unknown>;
export function insert(
  db: unknown,
  table: string,
  row: Record<string, unknown>,
): void;
export function measure(options?: {
  bills?: number;
  days?: number;
}): Record<string, unknown>;
