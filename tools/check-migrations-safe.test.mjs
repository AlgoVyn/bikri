import { describe, expect, it } from 'vitest';
import {
  destructiveFindings,
  functionArityFindings,
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

  it('rejects SQL functions above the D1 32-argument limit', () => {
    const pairs = Array.from({ length: 17 }, (_, i) => `'k${i}', 1`).join(', ');
    expect(functionArityFindings(`SELECT json_object(${pairs});`)).toEqual([
      { name: 'json_object', args: 34 },
    ]);
    const sixteen = Array.from({ length: 16 }, (_, i) => `'k${i}', 1`).join(
      ', ',
    );
    expect(functionArityFindings(`SELECT json_object(${sixteen});`)).toEqual(
      [],
    );
  });

  it('does not treat table definitions or literals as function calls', () => {
    expect(
      functionArityFindings(
        "CREATE TABLE t (id TEXT); INSERT INTO t (id) VALUES ('json_object(1,2)');",
      ),
    ).toEqual([]);
  });

  it('ignores commas and parentheses inside string literals when counting', () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => `'k${i}', 1`).join(
      ', ',
    );
    expect(
      functionArityFindings(
        `SELECT json_object('a,b', 1, ${fifteen}); SELECT json_object('x(', 1, ${fifteen});`,
      ),
    ).toEqual([]);
  });

  it('honours the reviewed allow marker', () => {
    expect(
      destructiveFindings(
        '-- bikri:allow-destructive\nALTER TABLE sales DROP legacy;',
      ),
    ).toEqual([]);
  });
});
