import { describe, expect, it } from 'vitest';
import {
  clearRestoreState,
  ExportZipError,
  hasStarted,
  importableRow,
  initialRestoreState,
  parseExport,
  type RestoreState,
  readRestoreState,
  reduceRestore,
  restoreAction,
  type TableSlice,
  writeRestoreState,
} from './restore.ts';
import { unzip, zipStore } from './zip.ts';

const text = new TextEncoder();

const tables: TableSlice[] = [
  { tbl: 'shop', count: 1 },
  { tbl: 'devices', count: 3 },
  { tbl: 'staff', count: 600 },
  { tbl: 'sales', count: 0 },
];

function memory(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('restore step machine', () => {
  it('walks maintenance, purge, import (skipping devices and empty), epoch, off', () => {
    let state = initialRestoreState();
    expect(hasStarted(state)).toBe(false);
    expect(restoreAction(state, tables)).toEqual({ type: 'maintenance_on' });
    state = reduceRestore(state, { type: 'maintenance_on' }, tables);
    expect(restoreAction(state, tables)).toEqual({ type: 'purge' });
    state = reduceRestore(state, { type: 'purged', remaining: 5 }, tables);
    expect(state.phase).toBe('purge');
    state = reduceRestore(state, { type: 'purged', remaining: 0 }, tables);
    expect(state.phase).toBe('import');

    const shop = restoreAction(state, tables);
    expect(shop).toMatchObject({ type: 'import', tbl: 'shop', from: 0, to: 1 });
    state = reduceRestore(state, { type: 'imported', count: 1 }, tables);

    const staff = restoreAction(state, tables);
    expect(staff).toMatchObject({
      type: 'import',
      tbl: 'staff',
      tableIndex: 2,
      from: 0,
      to: 500,
    });
    state = reduceRestore(state, { type: 'imported', count: 500 }, tables);
    expect(restoreAction(state, tables)).toMatchObject({
      tbl: 'staff',
      from: 500,
      to: 600,
    });
    state = reduceRestore(state, { type: 'imported', count: 100 }, tables);
    expect(restoreAction(state, tables)).toEqual({ type: 'epoch' });
    state = reduceRestore(state, { type: 'epoch' }, tables);
    expect(state.phase).toBe('maintenance_off');
    state = reduceRestore(state, { type: 'maintenance_off' }, tables);
    expect(state.phase).toBe('done');
    expect(restoreAction(state, tables)).toEqual({ type: 'done' });
  });

  it('abort keeps the position and resume continues the same import', () => {
    let state: RestoreState = {
      ...initialRestoreState(),
      phase: 'import',
      tableIndex: 2,
      rowOffset: 500,
    };
    state = reduceRestore(state, { type: 'abort' }, tables);
    expect(state.aborted).toBe(true);
    expect(state.tableIndex).toBe(2);
    expect(state.rowOffset).toBe(500);
    expect(restoreAction(state, tables)).toEqual({ type: 'halt' });
    state = reduceRestore(state, { type: 'resume' }, tables);
    expect(restoreAction(state, tables)).toMatchObject({
      type: 'import',
      tbl: 'staff',
      from: 500,
      to: 600,
    });
    const done = reduceRestore(
      { ...initialRestoreState(), phase: 'done' },
      { type: 'abort' },
      tables,
    );
    expect(done.phase).toBe('done');
    expect(done.aborted).toBe(false);
  });

  it('ignores events from the wrong phase and stores only version 1', () => {
    const start = initialRestoreState();
    expect(
      reduceRestore(start, { type: 'purged', remaining: 0 }, tables),
    ).toEqual(start);
    expect(
      reduceRestore(start, { type: 'imported', count: 0 }, tables),
    ).toEqual(start);
    const store = memory();
    const saved: RestoreState = {
      phase: 'purge',
      aborted: true,
      tableIndex: 0,
      rowOffset: 0,
      exportedAt: 42,
    };
    writeRestoreState('t1', saved, store);
    expect(readRestoreState('t1', store)).toEqual(saved);
    expect(readRestoreState('missing', store)).toBeNull();
    store.setItem('bikri.admin.restore.bad', '{');
    expect(readRestoreState('bad', store)).toBeNull();
    store.setItem(
      'bikri.admin.restore.old',
      JSON.stringify({ v: 2, phase: 'purge' }),
    );
    expect(readRestoreState('old', store)).toBeNull();
    clearRestoreState('t1', store);
    expect(readRestoreState('t1', store)).toBeNull();
  });
});

describe('export zip manifest', () => {
  it('reads a version 1 operator export and a version 2 owner export', async () => {
    const v1 = zipStore([
      {
        name: 'manifest.json',
        data: text.encode(
          JSON.stringify({
            format: 'bikri-export',
            version: 1,
            tenant: { id: 't1', slug: 'shop', display_name: 'Shop' },
            snapshot_seq: 9,
            exported_at: 1000,
            tables: [
              { tbl: 'shop', rows: 1 },
              { tbl: 'devices', rows: 0 },
            ],
          }),
        ),
      },
      {
        name: 'shop.json',
        data: text.encode(JSON.stringify([{ id: 'shop' }])),
      },
    ]);
    const parsed = parseExport(await unzip(v1));
    expect(parsed.tenant.id).toBe('t1');
    expect(parsed.snapshot_seq).toBe(9);
    expect(parsed.exported_at).toBe(1000);
    expect(parsed.tables.map((table) => table.tbl)).toEqual([
      'shop',
      'devices',
    ]);
    expect(parsed.tables[0]?.rows).toEqual([{ id: 'shop' }]);
    expect(parsed.tables[1]?.rows).toEqual([]);

    const v2 = zipStore([
      {
        name: 'manifest.json',
        data: text.encode(
          JSON.stringify({
            format: 'bikri-export',
            version: 2,
            tenant: { id: 't1', display_name: 'Shop' },
            exported_at: '2026-10-27T00:00:00.000Z',
            tables: { shop: 1 },
          }),
        ),
      },
      {
        name: 'json/shop.json',
        data: text.encode(
          JSON.stringify([{ id: 'shop', on: true, tenant_id: 't1' }]),
        ),
      },
    ]);
    const owner = parseExport(await unzip(v2));
    expect(owner.exported_at).toBe(Date.parse('2026-10-27T00:00:00.000Z'));
    expect(owner.tables).toEqual([
      { tbl: 'shop', rows: [{ id: 'shop', on: true, tenant_id: 't1' }] },
    ]);
    expect(importableRow(owner.tables[0]?.rows[0] ?? {})).toEqual({
      id: 'shop',
      on: 1,
    });
    expect(importableRow({ id: 1 })).toBeNull();
    expect(importableRow({ id: 'a', nest: { x: 1 } })).toBeNull();

    const bad = zipStore([
      { name: 'manifest.json', data: text.encode('{"format":"nope"}') },
    ]);
    await expect(unzip(bad).then(parseExport)).rejects.toBeInstanceOf(
      ExportZipError,
    );
  });
});
