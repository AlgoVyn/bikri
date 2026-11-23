import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkLocaleFiles,
  compareCatalogs,
  crossAreaDuplicates,
  unisolatedNumericRanges,
} from './check-keys.ts';

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

  it('fails on malformed braces even when every locale has them', () => {
    const malformed = { common: { a: 'Hi {{name}' } };
    const errors = compareCatalogs({
      en: malformed,
      ur: malformed,
      'roman-ur': malformed,
    });
    expect(errors).toContain('en malformed placeholders common.a');
    expect(errors).toContain('ur malformed placeholders common.a');
  });

  it('fails when a placeholder differs between locales', () => {
    const errors = compareCatalogs({
      en: { common: { a: 'Hi {{name}}' } },
      ur: { common: { a: 'سلام {{naam}}' } },
      'roman-ur': { common: { a: 'Salam {{name}}' } },
    });
    expect(errors).toContain('ur placeholders differ common.a');
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

describe('unisolatedNumericRanges', () => {
  it('accepts ranges wrapped in LRI/PDI', () => {
    expect(
      unisolatedNumericRanges({
        admin: { pin_hint: '\u20664–6\u2069 ہندسے۔' },
        office: { group: '⁦0–7⁩ دن', size: '⁦38 × 25⁩ ملی میٹر' },
      }),
    ).toEqual([]);
  });

  it('flags bare ranges and dimensions in either direction', () => {
    expect(
      unisolatedNumericRanges({
        admin: { slug_hint: '3–30 حروف۔' },
        office: { size: '38 × 25 ملی میٹر', reason: '1–120 حروف' },
      }),
    ).toEqual(['admin.slug_hint', 'office.reason', 'office.size']);
  });

  it('flags an unterminated isolate', () => {
    expect(unisolatedNumericRanges({ a: '\u20663–30 حروف' })).toEqual(['a']);
    expect(unisolatedNumericRanges({ a: '3–30\u2069 حروف' })).toEqual(['a']);
  });
});

describe('crossAreaDuplicates', () => {
  it('passes when every area has its own namespace', () => {
    expect(
      crossAreaDuplicates({
        root: { common: { app_name: 'Bikri' } },
        admin: { admin: { title: 'Admin' } },
        office: { office: { title: 'Office' } },
        public: { public: { title: 'Register' } },
      }),
    ).toEqual([]);
  });

  it('flags the same flattened key in two areas', () => {
    expect(
      crossAreaDuplicates({
        root: { common: { app_name: 'Bikri' }, office: { title: 'x' } },
        office: { office: { title: 'y' } },
      }),
    ).toEqual(['duplicate key office.title in root and office']);
  });
});

describe('checkLocaleFiles', () => {
  it('rejects keys shared between the root and an area catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bikri-i18n-'));
    try {
      const root = {
        common: { app_name: 'Bikri' },
        office: { title: 'Office' },
      };
      const areas: Record<string, unknown> = {
        admin: { admin: { title: 'Admin' } },
        office: { office: { title: 'Office' } },
        public: { public: { title: 'Register' } },
      };
      for (const [area, catalog] of Object.entries({
        '.': root,
        ...areas,
      })) {
        const target = join(dir, area);
        await mkdir(target, { recursive: true });
        for (const locale of ['en', 'ur', 'roman-ur']) {
          await writeFile(
            join(target, `${locale}.json`),
            JSON.stringify(catalog),
          );
        }
      }
      const errors = await checkLocaleFiles(dir);
      expect(errors).toContain(
        'en: duplicate key office.title in root and office',
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
