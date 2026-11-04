import { PERMISSIONS } from '@bikri/core';
import { LOCALE_CODES, loadAreaCatalog } from '@bikri/i18n';
import { describe, expect, it } from 'vitest';

type OfficeCatalog = {
  office?: { staff?: Record<string, unknown> };
};

/** Every permission in the matrix must have a visible label in every locale. */
describe('staff permission labels', () => {
  for (const locale of LOCALE_CODES) {
    it(`has a label for every permission (${locale})`, async () => {
      const catalog = (await loadAreaCatalog(
        'office',
        locale,
      )) as unknown as OfficeCatalog;
      const staff = catalog.office?.staff ?? {};
      for (const permission of PERMISSIONS) {
        const key = `perm_${permission.replaceAll('.', '_')}`;
        expect(staff[key], `${locale} missing ${key}`).toEqual(
          expect.any(String),
        );
        expect(String(staff[key]).trim(), `${locale} empty ${key}`).not.toBe(
          '',
        );
      }
    });
  }
});
