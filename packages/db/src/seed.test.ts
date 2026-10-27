import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EXPENSE_CATEGORY_TEMPLATES } from './seed.ts';

describe('expense category templates', () => {
  it('match 0002_seed.sql exactly', () => {
    const sql = readFileSync(
      new URL('../migrations/0002_seed.sql', import.meta.url),
      'utf8',
    );
    const rows = [
      ...sql.matchAll(/\('([a-z_]+)','([^']+)','([^']+)','([a-z]+)',(\d+)\)/g),
    ].map((m) => ({
      code: m[1],
      name_en: m[2],
      name_ur: m[3],
      icon: m[4],
      sort_order: Number(m[5]),
    }));
    expect(rows).toEqual(EXPENSE_CATEGORY_TEMPLATES);
  });
});
