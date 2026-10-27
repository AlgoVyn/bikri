import type { ExportRow } from './types.ts';

/** Rows per `POST /admin/tenants/:id/import` call (04 §3.7). */
export const RESTORE_CHUNK = 500;

export type RestorePhase =
  | 'maintenance_on'
  | 'purge'
  | 'import'
  | 'epoch'
  | 'maintenance_off'
  | 'done';

export type RestoreState = {
  phase: RestorePhase;
  aborted: boolean;
  tableIndex: number;
  rowOffset: number;
  exportedAt: number | null;
};

export type TableSlice = { tbl: string; count: number };

export type RestoreAction =
  | { type: 'maintenance_on' }
  | { type: 'purge' }
  | {
      type: 'import';
      tbl: string;
      tableIndex: number;
      from: number;
      to: number;
    }
  | { type: 'epoch' }
  | { type: 'maintenance_off' }
  | { type: 'done' }
  | { type: 'halt' };

export type RestoreEvent =
  | { type: 'maintenance_on' }
  | { type: 'purged'; remaining: number }
  | { type: 'imported'; count: number }
  | { type: 'epoch' }
  | { type: 'maintenance_off' }
  | { type: 'abort' }
  | { type: 'resume' };

export function initialRestoreState(): RestoreState {
  return {
    phase: 'maintenance_on',
    aborted: false,
    tableIndex: 0,
    rowOffset: 0,
    exportedAt: null,
  };
}

export function hasStarted(state: RestoreState): boolean {
  return (
    state.aborted ||
    state.phase !== 'maintenance_on' ||
    state.tableIndex !== 0 ||
    state.rowOffset !== 0
  );
}

function nextSlice(
  state: RestoreState,
  tables: readonly TableSlice[],
): { tbl: string; tableIndex: number; from: number; to: number } | null {
  let index = state.tableIndex;
  let offset = state.rowOffset;
  while (index < tables.length) {
    const table = tables[index];
    if (
      table === undefined ||
      table.tbl === 'devices' ||
      table.count <= 0 ||
      offset >= table.count
    ) {
      index += 1;
      offset = 0;
      continue;
    }
    return {
      tbl: table.tbl,
      tableIndex: index,
      from: offset,
      to: Math.min(table.count, offset + RESTORE_CHUNK),
    };
  }
  return null;
}

/** The next operator call for this state. Devices and empty tables are skipped. */
export function restoreAction(
  state: RestoreState,
  tables: readonly TableSlice[],
): RestoreAction {
  if (state.aborted) return { type: 'halt' };
  if (state.phase === 'done') return { type: 'done' };
  if (state.phase === 'maintenance_on') return { type: 'maintenance_on' };
  if (state.phase === 'purge') return { type: 'purge' };
  if (state.phase === 'maintenance_off') return { type: 'maintenance_off' };
  if (state.phase === 'epoch') return { type: 'epoch' };
  const slice = nextSlice(state, tables);
  if (slice === null) return { type: 'epoch' };
  return { type: 'import', ...slice };
}

/** Pure step machine. Abort keeps the position and does not leave maintenance. */
export function reduceRestore(
  state: RestoreState,
  event: RestoreEvent,
  tables: readonly TableSlice[],
): RestoreState {
  if (event.type === 'abort') {
    if (state.phase === 'done') return state;
    return { ...state, aborted: true };
  }
  if (event.type === 'resume') return { ...state, aborted: false };
  if (state.aborted) return state;
  if (event.type === 'maintenance_on' && state.phase === 'maintenance_on') {
    return { ...state, phase: 'purge' };
  }
  if (event.type === 'purged' && state.phase === 'purge') {
    if (event.remaining > 0) return state;
    return { ...state, phase: 'import', tableIndex: 0, rowOffset: 0 };
  }
  if (event.type === 'imported' && state.phase === 'import') {
    if (event.count <= 0) return state;
    const action = restoreAction(state, tables);
    if (action.type !== 'import') return state;
    const table = tables[action.tableIndex];
    if (table === undefined) return state;
    const offset = action.from + event.count;
    const next: RestoreState =
      offset >= table.count
        ? { ...state, tableIndex: action.tableIndex + 1, rowOffset: 0 }
        : { ...state, tableIndex: action.tableIndex, rowOffset: offset };
    if (restoreAction(next, tables).type === 'epoch') {
      return { ...next, phase: 'epoch' };
    }
    return next;
  }
  if (
    event.type === 'epoch' &&
    (state.phase === 'epoch' || state.phase === 'import')
  ) {
    return { ...state, phase: 'maintenance_off' };
  }
  if (event.type === 'maintenance_off' && state.phase === 'maintenance_off') {
    return { ...state, phase: 'done' };
  }
  return state;
}

const STORAGE_PREFIX = 'bikri.admin.restore.';

export function restoreStorageKey(tenantId: string): string {
  return `${STORAGE_PREFIX}${tenantId}`;
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function isPhase(value: unknown): value is RestorePhase {
  return (
    value === 'maintenance_on' ||
    value === 'purge' ||
    value === 'import' ||
    value === 'epoch' ||
    value === 'maintenance_off' ||
    value === 'done'
  );
}

export function readRestoreState(
  tenantId: string,
  storage: Pick<Storage, 'getItem'>,
): RestoreState | null {
  const raw = storage.getItem(restoreStorageKey(tenantId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (row.v !== 1 || !isPhase(row.phase) || typeof row.aborted !== 'boolean') {
    return null;
  }
  if (
    typeof row.tableIndex !== 'number' ||
    typeof row.rowOffset !== 'number' ||
    !Number.isInteger(row.tableIndex) ||
    !Number.isInteger(row.rowOffset)
  ) {
    return null;
  }
  const exportedAt =
    typeof row.exportedAt === 'number' && Number.isFinite(row.exportedAt)
      ? row.exportedAt
      : null;
  return {
    phase: row.phase,
    aborted: row.aborted,
    tableIndex: row.tableIndex,
    rowOffset: row.rowOffset,
    exportedAt,
  };
}

export function writeRestoreState(
  tenantId: string,
  state: RestoreState,
  storage: Store,
): void {
  storage.setItem(
    restoreStorageKey(tenantId),
    JSON.stringify({ v: 1, ...state }),
  );
}

export function clearRestoreState(tenantId: string, storage: Store): void {
  storage.removeItem(restoreStorageKey(tenantId));
}

export class ExportZipError extends Error {
  readonly code: 'bad_manifest';

  constructor() {
    super('bad_manifest');
    this.name = 'ExportZipError';
    this.code = 'bad_manifest';
  }
}

export type ParsedExport = {
  tenant: { id: string; slug: string; display_name: string };
  snapshot_seq: number | null;
  exported_at: number;
  tables: { tbl: string; rows: ExportRow[] }[];
};

function asRows(value: unknown): ExportRow[] | null {
  if (!Array.isArray(value)) return null;
  const rows: ExportRow[] = [];
  for (const row of value) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return null;
    }
    rows.push(row as ExportRow);
  }
  return rows;
}

function fileText(
  files: readonly { name: string; data: Uint8Array }[],
  name: string,
): string | null {
  const hit =
    files.find((file) => file.name === name) ??
    files.find((file) => file.name.endsWith(`/${name}`));
  if (hit === undefined) return null;
  return new TextDecoder().decode(hit.data);
}

function exportedAtOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Reads a bikri-export manifest. Version 1 lists `tables: [{tbl, rows}]` and
 * `<tbl>.json`. Version 2 (owner export) lists `tables: {name: count}` and
 * `json/<tbl>.json`.
 */
export function parseExport(
  files: readonly { name: string; data: Uint8Array }[],
): ParsedExport {
  const manifestText = fileText(files, 'manifest.json');
  if (manifestText === null) throw new ExportZipError();
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new ExportZipError();
  }
  if (manifest === null || typeof manifest !== 'object') {
    throw new ExportZipError();
  }
  const body = manifest as Record<string, unknown>;
  if (body.format !== 'bikri-export') throw new ExportZipError();
  const tenant = body.tenant;
  if (tenant === null || typeof tenant !== 'object') throw new ExportZipError();
  const tenantRow = tenant as Record<string, unknown>;
  if (typeof tenantRow.id !== 'string' || tenantRow.id === '') {
    throw new ExportZipError();
  }
  const exported = exportedAtOf(body.exported_at);
  if (exported === null) throw new ExportZipError();
  const order: string[] = [];
  if (Array.isArray(body.tables)) {
    for (const item of body.tables) {
      if (item === null || typeof item !== 'object') throw new ExportZipError();
      const tbl = (item as { tbl?: unknown }).tbl;
      if (typeof tbl !== 'string' || tbl === '') throw new ExportZipError();
      order.push(tbl);
    }
  } else if (body.tables !== null && typeof body.tables === 'object') {
    for (const tbl of Object.keys(body.tables as Record<string, unknown>)) {
      order.push(tbl);
    }
  } else {
    throw new ExportZipError();
  }
  const tables: ParsedExport['tables'] = [];
  for (const tbl of order) {
    const text =
      fileText(files, `${tbl}.json`) ?? fileText(files, `json/${tbl}.json`);
    if (text === null) {
      tables.push({ tbl, rows: [] });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ExportZipError();
    }
    const rows = asRows(parsed);
    if (rows === null) throw new ExportZipError();
    tables.push({ tbl, rows });
  }
  const seq = body.snapshot_seq;
  return {
    tenant: {
      id: tenantRow.id,
      slug: typeof tenantRow.slug === 'string' ? tenantRow.slug : '',
      display_name:
        typeof tenantRow.display_name === 'string'
          ? tenantRow.display_name
          : '',
    },
    snapshot_seq: typeof seq === 'number' && Number.isFinite(seq) ? seq : null,
    exported_at: exported,
    tables,
  };
}

/** Coerce an export row into the scalars `POST …/import` accepts. */
export function importableRow(
  row: ExportRow,
): Record<string, string | number | null> | null {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'tenant_id') continue;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number'
    ) {
      out[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      out[key] = value ? 1 : 0;
      continue;
    }
    return null;
  }
  if (typeof out.id !== 'string') return null;
  return out;
}
