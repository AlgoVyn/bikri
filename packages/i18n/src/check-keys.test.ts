import { describe, expect, it } from 'vitest';
import { compareCatalogs } from './check-keys.ts';

const complete = {
  common: { a: 'A', b: 'B' },
};

describe('compareCatalogs', () => {
  it('fails when a locale is missing a key', () => {
    const errors = compareCatalogs({
      en: complete,
      ur: { common: { a: 'ا' } },
      'roman-ur': complete,
    });
    expect(errors).toContain('ur missing common.b');
  });

  it('fails when a value is empty', () => {
    const errors = compareCatalogs({
      en: { common: { a: '   ' } },
      ur: { common: { a: 'ا' } },
      'roman-ur': { common: { a: 'A' } },
    });
    expect(errors).toContain('en empty common.a');
  });

  it('passes when the key sets and values match', () => {
    expect(
      compareCatalogs({
        en: complete,
        ur: { common: { a: 'ا', b: 'ب' } },
        'roman-ur': { common: { a: 'A', b: 'B' } },
      }),
    ).toEqual([]);
  });
});
