import { describe, expect, it } from 'vitest';
import {
  destructiveFindings,
  stripComments,
} from './check-migrations-safe.mjs';

describe('destructive migration guard', () => {
  it('finds DROP TABLE and DROP VIEW', () => {
    expect(destructiveFindings('DROP TABLE sales;')).toEqual(['DROP TABLE']);
    expect(destructiveFindings('drop view v_sales;')).toEqual(['DROP VIEW']);
  });

  it('finds DROP COLUMN with and without the optional keyword', () => {
    expect(
      destructiveFindings('ALTER TABLE sales DROP COLUMN remarks;'),
    ).toEqual(['DROP COLUMN']);
    expect(destructiveFindings('alter table sales drop remarks;')).toEqual([
      'DROP COLUMN',
    ]);
    expect(destructiveFindings('ALTER TABLE "sales" DROP "remarks";')).toEqual([
      'DROP COLUMN',
    ]);
  });

  it('finds both RENAME forms', () => {
    expect(
      destructiveFindings('ALTER TABLE sales RENAME COLUMN old TO new;'),
    ).toEqual(['RENAME TABLE/COLUMN']);
    expect(destructiveFindings('ALTER TABLE sales RENAME old TO new;')).toEqual(
      ['RENAME TABLE/COLUMN'],
    );
    expect(
      destructiveFindings('ALTER TABLE sales RENAME TO old_sales;'),
    ).toEqual(['RENAME TABLE/COLUMN']);
  });

  it('allows additive and index-rebuild statements', () => {
    expect(
      destructiveFindings(`
        CREATE TABLE notes (id TEXT) STRICT;
        ALTER TABLE notes ADD COLUMN body TEXT;
        DROP INDEX IF EXISTS notes_old;
        CREATE INDEX notes_body ON notes (body);
      `),
    ).toEqual([]);
  });

  it('keeps -- and /* */ inside quoted SQL literals', () => {
    expect(stripComments("SELECT '-- not a comment';")).toBe(
      "SELECT '-- not a comment';",
    );
    expect(stripComments('SELECT "a /* b */ c";')).toBe(
      'SELECT "a /* b */ c";',
    );
    expect(
      stripComments("INSERT INTO x VALUES('--'); ALTER TABLE x DROP y;"),
    ).toContain('ALTER TABLE x DROP y');
    expect(
      destructiveFindings("INSERT INTO x VALUES('--'); ALTER TABLE x DROP y;"),
    ).toEqual(['DROP COLUMN']);
  });

  it('removes real comments, including a quoted -- after a real comment', () => {
    expect(stripComments("-- it's a comment\nSELECT 1;")).toBe('\nSELECT 1;');
    expect(stripComments('SELECT 1; /* drop table */ SELECT 2;')).not.toContain(
      'drop table',
    );
  });

  it('honours the reviewed allow marker', () => {
    expect(
      destructiveFindings(
        '-- bikri:allow-destructive\nALTER TABLE sales DROP legacy;',
      ),
    ).toEqual([]);
  });
});
