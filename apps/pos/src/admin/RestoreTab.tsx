import {
  Box,
  Button,
  FileInput,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useRef, useState } from 'react';
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
  type ParsedExport,
  parseExport,
  type RestorePhase,
  type RestoreState,
  readRestoreState,
  reduceRestore,
  restoreAction,
  writeRestoreState,
} from './restore.ts';
import { Panel } from './ui.tsx';
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
  const abortRef = useRef(false);
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
    >
      <Stack gap="md">
        <FileInput
          id="restore-file"
          label={t('admin.restore_file')}
          accept=".zip,application/zip"
          disabled={running}
          value={null}
          onChange={(file) => {
            if (file === null) return;
            void file.arrayBuffer().then(async (buffer) => {
              try {
                const parsed = parseExport(await unzip(new Uint8Array(buffer)));
                if (parsed.tenant.id !== tenantId) {
                  setZip(null);
                  setError(t('admin.restore_wrong_shop'));
                  toast.push(t('admin.restore_wrong_shop'), 'error');
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
                setError(null);
                commit(next);
              } catch {
                setZip(null);
                setError(t('admin.restore_bad_zip'));
                toast.push(t('admin.restore_bad_zip'), 'error');
              }
            });
          }}
        />
        <Box component="section" aria-labelledby="restore-steps">
          <Title order={3} fz="sm" c="dimmed" id="restore-steps">
            {t('admin.restore_steps')}
          </Title>
          <SimpleGrid
            component="ol"
            cols={{ base: 1, sm: 2, lg: 3 }}
            spacing="xs"
            mt="xs"
            style={{ listStyle: 'none', margin: 0, padding: 0 }}
          >
            {STEP_KEYS.map((key, index) => {
              const done = index < current;
              const active = index === current;
              return (
                <Paper
                  component="li"
                  key={key}
                  withBorder
                  p="sm"
                  aria-current={active ? 'step' : undefined}
                  bg={
                    active
                      ? 'var(--mantine-color-brand-light)'
                      : done
                        ? 'var(--mantine-color-success-light)'
                        : undefined
                  }
                >
                  <Group gap="xs" wrap="nowrap">
                    <ThemeIcon
                      size={20}
                      radius="xl"
                      variant={done ? 'filled' : 'light'}
                      color={done ? 'success' : active ? 'brand' : 'gray'}
                    >
                      <Text size="xs" fw={600}>
                        {done ? '✓' : index + 1}
                      </Text>
                    </ThemeIcon>
                    <Text
                      size="sm"
                      fw={active ? 500 : undefined}
                      c={!active && !done ? 'dimmed' : undefined}
                    >
                      {t(key)}
                    </Text>
                  </Group>
                </Paper>
              );
            })}
          </SimpleGrid>
        </Box>
        {note !== null ? (
          <Paper p="sm" bg="var(--color-info-subtle)">
            <Text size="sm" c="var(--color-info-subtle-ink)">
              {note}
            </Text>
          </Paper>
        ) : null}
        {error !== null ? (
          <Text size="sm" c="danger" role="alert">
            {error}
          </Text>
        ) : null}
        {state.phase === 'done' ? (
          <Paper p="sm" bg="var(--mantine-color-success-light)">
            <Text size="sm" c="var(--color-success)">
              {t('admin.restore_done')}
            </Text>
          </Paper>
        ) : null}
        <Group
          gap="sm"
          pt="md"
          style={{ borderTop: '1px solid var(--mantine-color-default-border)' }}
        >
          <Button
            type="button"
            loading={running}
            disabled={running || zip === null || state.phase === 'done'}
            onClick={() => {
              if (zip === null) {
                setError(t('admin.restore_need_file'));
                return;
              }
              const loaded = zip;
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
                let previousRemaining: number | null = null;
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
                    if (
                      result.remaining > 0 &&
                      previousRemaining !== null &&
                      result.remaining >= previousRemaining
                    ) {
                      throw new RestoreStuck();
                    }
                    previousRemaining = result.remaining;
                    setNote(
                      t('admin.restore_purged', {
                        remaining: formatCount(result.remaining, lang),
                      }),
                    );
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
                      const coerced = importableRow(row);
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
                  toast.push(
                    adminErrorMessage(err, t('admin.err_generic')),
                    'error',
                  );
                })
                .finally(() => {
                  setRunning(false);
                });
            }}
          >
            {state.aborted ? t('admin.restore_resume') : t('admin.restore_run')}
          </Button>
          <Button
            type="button"
            color="danger"
            disabled={!running}
            onClick={() => {
              abortRef.current = true;
            }}
          >
            {t('admin.restore_abort')}
          </Button>
        </Group>
        {zip === null && hasStarted(state) && state.phase !== 'done' ? (
          <p className="text-small text-text-muted">
            {t('admin.restore_need_file')}
          </p>
        ) : null}
      </Stack>
    </Panel>
  );
}
