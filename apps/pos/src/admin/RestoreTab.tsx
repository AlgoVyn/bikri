import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../components/Toast.tsx';
import {
  adminErrorMessage,
  importRows,
  purgeTenant,
  restoreEpoch,
  setMaintenance,
} from './api.ts';
import { formatCount } from './format.ts';
import {
  ExportZipError,
  hasStarted,
  importableRow,
  initialRestoreState,
  missingRestoreTables,
  type ParsedExport,
  parseExport,
  type RestorePhase,
  type RestoreState,
  readRestoreState,
  reduceRestore,
  restoreAction,
  writeRestoreState,
} from './restore.ts';
import { dangerBtn, FileField, Panel, primaryBtn } from './ui.tsx';
import { unzip, ZipError } from './zip.ts';

const STEP_KEYS = [
  'admin.step_file',
  'admin.step_maint_on',
  'admin.step_purge',
  'admin.step_import',
  'admin.step_epoch',
  'admin.step_maint_off',
] as const;

class RestoreStuck extends Error {
  constructor() {
    super('stuck');
    this.name = 'RestoreStuck';
  }
}

class RestoreLoop extends Error {
  constructor() {
    super('loop');
    this.name = 'RestoreLoop';
  }
}

/** One restore per tenant at a time, even if the tab that started it was unmounted. */
const activeRestore = new Set<string>();

function slicesOf(zip: ParsedExport): { tbl: string; count: number }[] {
  return zip.tables.map((table) => ({
    tbl: table.tbl,
    count: table.rows.length,
  }));
}

function stepIndex(phase: RestorePhase, hasFile: boolean): number {
  if (phase === 'done') return STEP_KEYS.length;
  if (phase === 'maintenance_off') return 5;
  if (phase === 'epoch') return 4;
  if (phase === 'import') return 3;
  if (phase === 'purge') return 2;
  if (hasFile) return 1;
  return 0;
}

export function RestoreTab({
  tenantId,
  onChanged,
  onState,
}: {
  tenantId: string;
  onChanged: () => void;
  onState: () => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const lang = i18n.language;
  const [zip, setZip] = useState<ParsedExport | null>(null);
  const [state, setState] = useState<RestoreState>(
    () => readRestoreState(tenantId, sessionStorage) ?? initialRestoreState(),
  );
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const abortRef = useRef(false);
  const pickSeq = useRef(0);
  // Switching tabs unmounts this component; stop the async loop instead of letting a
  // second RestoreTab start another restore against the same tenant.
  useEffect(
    () => () => {
      abortRef.current = true;
    },
    [],
  );
  const current = stepIndex(state.phase, zip !== null);

  const commit = (next: RestoreState) => {
    writeRestoreState(tenantId, next, sessionStorage);
    setState(next);
    onState();
  };

  return (
    <Panel
      title={t('admin.tab_restore')}
      description={t('admin.restore_intro')}
      className="mx-auto w-full max-w-3xl"
    >
      <div className="flex flex-col gap-4">
        <FileField
          id="restore-file"
          label={t('admin.restore_file')}
          accept=".zip,application/zip"
          disabled={running}
          onPick={(file) => {
            pickSeq.current += 1;
            const seq = pickSeq.current;
            if (file === null) {
              setZip(null);
              setConfirmed(false);
              setError(null);
              return;
            }
            void file
              .arrayBuffer()
              .then(async (buffer) => {
                if (seq !== pickSeq.current) return;
                try {
                  const parsed = parseExport(
                    await unzip(new Uint8Array(buffer), {
                      // The restore needs the JSON tables; skipping the CSV mirrors
                      // avoids inflating a second copy of every row.
                      include: (name) =>
                        name === 'manifest.json' || name.endsWith('.json'),
                    }),
                  );
                  // A newer pick (or Clear) may have landed while the archive inflated.
                  if (seq !== pickSeq.current) return;
                  if (parsed.tenant.id !== tenantId) {
                    setZip(null);
                    setError(t('admin.restore_wrong_shop'));
                    toast.push(t('admin.restore_wrong_shop'), 'error');
                    return;
                  }
                  if (missingRestoreTables(parsed).length > 0) {
                    setZip(null);
                    setError(t('admin.restore_incomplete'));
                    toast.push(t('admin.restore_incomplete'), 'error');
                    return;
                  }
                  const stored =
                    readRestoreState(tenantId, sessionStorage) ??
                    initialRestoreState();
                  const base =
                    stored.phase === 'done' ? initialRestoreState() : stored;
                  if (
                    base.exportedAt !== null &&
                    base.exportedAt !== parsed.exported_at &&
                    hasStarted(base)
                  ) {
                    setZip(null);
                    setError(t('admin.restore_different_zip'));
                    toast.push(t('admin.restore_different_zip'), 'error');
                    return;
                  }
                  const next = { ...base, exportedAt: parsed.exported_at };
                  setZip(parsed);
                  setConfirmed(false);
                  setError(null);
                  commit(next);
                } catch {
                  setZip(null);
                  setError(t('admin.restore_bad_zip'));
                  toast.push(t('admin.restore_bad_zip'), 'error');
                }
              })
              .catch(() => {
                if (seq !== pickSeq.current) return;
                // Reading the picked file can fail (removed drive, permission); do not
                // leave the operator with a silently ignored click.
                setZip(null);
                setError(t('admin.restore_bad_zip'));
                toast.push(t('admin.restore_bad_zip'), 'error');
              });
          }}
        />
        <section aria-labelledby="restore-steps">
          <h2
            id="restore-steps"
            className="text-small font-medium text-text-muted"
          >
            {t('admin.restore_steps')}
          </h2>
          <ol className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {STEP_KEYS.map((key, index) => {
              const done = index < current;
              const active = index === current;
              return (
                <li
                  key={key}
                  aria-current={active ? 'step' : undefined}
                  className={`flex items-center gap-2 rounded-control border px-3 py-2 text-small ${
                    active
                      ? 'border-primary bg-primary-subtle font-medium text-primary-subtle-ink'
                      : done
                        ? 'border-success-subtle bg-success-subtle text-success-subtle-ink'
                        : 'border-border text-text-muted'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface/70 text-caption font-semibold"
                  >
                    {done ? '✓' : index + 1}
                  </span>
                  {t(key)}
                </li>
              );
            })}
          </ol>
        </section>
        {note !== null ? (
          <p className="rounded-control bg-info-subtle px-3 py-2 text-small text-info-subtle-ink tabular-nums">
            {note}
          </p>
        ) : null}
        {error !== null ? (
          <p className="text-small text-danger" role="alert">
            {error}
          </p>
        ) : null}
        {state.phase === 'done' ? (
          <p className="rounded-control bg-success-subtle px-3 py-2 text-small text-success-subtle-ink">
            {t('admin.restore_done')}
          </p>
        ) : null}
        <label className="flex items-start gap-2 text-small">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>{t('admin.restore_confirm')}</span>
        </label>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <button
            type="button"
            className={primaryBtn}
            disabled={
              running || zip === null || state.phase === 'done' || !confirmed
            }
            onClick={() => {
              if (zip === null) {
                setError(t('admin.restore_need_file'));
                return;
              }
              if (activeRestore.has(tenantId)) {
                toast.push(t('admin.restore_busy'), 'info');
                return;
              }
              const loaded = zip;
              activeRestore.add(tenantId);
              abortRef.current = false;
              setRunning(true);
              setError(null);
              const tables = slicesOf(loaded);
              void (async () => {
                let cursor: RestoreState =
                  state.phase === 'done'
                    ? {
                        ...initialRestoreState(),
                        exportedAt: loaded.exported_at,
                      }
                    : {
                        ...reduceRestore(state, { type: 'resume' }, tables),
                        exportedAt: loaded.exported_at,
                      };
                commit(cursor);
                for (let guard = 0; guard < 100_000; guard += 1) {
                  if (abortRef.current) {
                    cursor = reduceRestore(cursor, { type: 'abort' }, tables);
                    commit(cursor);
                    toast.push(t('admin.restore_aborted'), 'info');
                    onChanged();
                    return;
                  }
                  const action = restoreAction(cursor, tables);
                  if (action.type === 'halt' || action.type === 'done') return;
                  if (action.type === 'maintenance_on') {
                    await setMaintenance(
                      tenantId,
                      true,
                      t('admin.restore_reason'),
                    );
                    cursor = reduceRestore(
                      cursor,
                      { type: 'maintenance_on' },
                      tables,
                    );
                    onChanged();
                  } else if (action.type === 'purge') {
                    const result = await purgeTenant(tenantId);
                    // `remaining` is 0/1 now (an exact row count cost a full scan per
                    // chunk); a call that deletes nothing while rows remain is stuck.
                    if (result.remaining > 0 && result.deleted === 0) {
                      throw new RestoreStuck();
                    }
                    setNote(t('admin.restore_purging'));
                    cursor = reduceRestore(
                      cursor,
                      { type: 'purged', remaining: result.remaining },
                      tables,
                    );
                  } else if (action.type === 'import') {
                    const table = loaded.tables[action.tableIndex];
                    if (table === undefined || table.tbl !== action.tbl) {
                      throw new ExportZipError();
                    }
                    const raw = table.rows.slice(action.from, action.to);
                    const rows: Record<string, string | number | null>[] = [];
                    for (const row of raw) {
                      const coerced = importableRow(row, action.tbl);
                      if (coerced === null) throw new ExportZipError();
                      rows.push(coerced);
                    }
                    if (rows.length > 0)
                      await importRows(
                        tenantId,
                        action.tbl,
                        rows,
                        t('admin.restore_reason'),
                      );
                    const count = Math.max(1, action.to - action.from);
                    setNote(
                      t('admin.restore_importing', {
                        table: action.tbl,
                        done: formatCount(action.to, lang),
                        total: formatCount(table.rows.length, lang),
                      }),
                    );
                    cursor = reduceRestore(
                      cursor,
                      { type: 'imported', count },
                      tables,
                    );
                  } else if (action.type === 'epoch') {
                    const at = cursor.exportedAt ?? loaded.exported_at;
                    await restoreEpoch(tenantId, at, t('admin.restore_reason'));
                    cursor = reduceRestore(cursor, { type: 'epoch' }, tables);
                  } else if (action.type === 'maintenance_off') {
                    await setMaintenance(
                      tenantId,
                      false,
                      t('admin.restore_finished_reason'),
                    );
                    cursor = reduceRestore(
                      cursor,
                      { type: 'maintenance_off' },
                      tables,
                    );
                    onChanged();
                  }
                  commit(cursor);
                  if (cursor.phase === 'done') {
                    toast.push(t('admin.restore_done'), 'info');
                    onChanged();
                    return;
                  }
                }
                // The state machine never reached done/halt: do not exit silently
                // with a partially restored shop.
                throw new RestoreLoop();
              })()
                .catch((err: unknown) => {
                  if (
                    err instanceof ExportZipError ||
                    err instanceof ZipError
                  ) {
                    setError(t('admin.restore_bad_zip'));
                    toast.push(t('admin.restore_bad_zip'), 'error');
                    return;
                  }
                  if (err instanceof RestoreStuck) {
                    setError(t('admin.restore_stuck'));
                    toast.push(t('admin.restore_stuck'), 'error');
                    return;
                  }
                  if (err instanceof RestoreLoop) {
                    setError(t('admin.restore_loop'));
                    toast.push(t('admin.restore_loop'), 'error');
                    return;
                  }
                  const message = adminErrorMessage(
                    err,
                    t('admin.err_generic'),
                  );
                  setError(message);
                  toast.push(message, 'error');
                })
                .finally(() => {
                  activeRestore.delete(tenantId);
                  setRunning(false);
                });
            }}
          >
            {state.aborted ? t('admin.restore_resume') : t('admin.restore_run')}
          </button>
          <button
            type="button"
            className={dangerBtn}
            disabled={!running}
            onClick={() => {
              abortRef.current = true;
            }}
          >
            {t('admin.restore_abort')}
          </button>
        </div>
        {zip === null && hasStarted(state) && state.phase !== 'done' ? (
          <p className="text-small text-text-muted">
            {t('admin.restore_need_file')}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
