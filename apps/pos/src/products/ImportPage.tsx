import {
  Box,
  Button,
  Group,
  NativeSelect,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { Link, Navigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ProductsIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { ledgerContext } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import {
  autoMap,
  errorsCsv,
  type ImportField,
  type ImportPreview,
  type ImportResult,
  MAX_IMPORT_ROWS,
  type Mapping,
  previewImport,
  type RowError,
  runImport,
  TEMPLATE_COLUMNS,
  TEMPLATE_FILE,
  templateCsv,
} from '../data/importProducts.ts';
import { downloadText } from '../lib/download.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { readSheetFile } from './sheetFile.ts';

const PREVIEW_LIMIT = 200;

type Stage =
  | { step: 'choose' }
  | { step: 'map'; grid: string[][]; mapping: Mapping; file: string }
  | {
      step: 'preview';
      grid: string[][];
      mapping: Mapping;
      file: string;
      preview: ImportPreview;
    }
  | { step: 'importing'; done: number; total: number; preview: ImportPreview }
  | { step: 'done'; result: ImportResult; preview: ImportPreview };

/** Import spreadsheet (screens/08): choose → map columns → preview → import. */
export function ImportPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [stage, setStage] = useState<Stage>({ step: 'choose' });
  const [readError, setReadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileId = useId();
  if (!can('catalog.edit')) return <Navigate to="/products" replace />;

  const message = (e: RowError) =>
    t(`import.err.${e.code}`, { name: e.name ?? '', max: MAX_IMPORT_ROWS });
  const downloadErrors = (preview: ImportPreview) =>
    downloadText('import-errors.csv', errorsCsv(preview, message));

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
    setFileName(file.name);
    try {
      const grid = await readSheetFile(file);
      if (grid.length < 2) {
        setReadError(t('import.empty'));
        return;
      }
      setStage({
        step: 'map',
        grid,
        mapping: autoMap(grid[0] ?? []),
        file: file.name,
      });
    } catch {
      setReadError(t('import.read_failed'));
    }
  };

  const toPreview = async (
    grid: string[][],
    mapping: Mapping,
    file: string,
  ) => {
    const preview = await previewImport(getDb(), grid, mapping);
    setStage({ step: 'preview', grid, mapping, file, preview });
  };

  const doImport = async (preview: ImportPreview) => {
    const total = preview.summary.new + preview.summary.updates;
    setStage({ step: 'importing', done: 0, total, preview });
    try {
      const ctx = await ledgerContext(getDb(), staff?.id ?? '');
      const result = await runImport(getDb(), preview, ctx, {
        onProgress: (done, all) => {
          // Importing 1,000 rows re-renders the progress card; update in batches so the
          // database work stays well inside the 10 s budget on a phone.
          if (done === all || done % 100 === 0)
            setStage({ step: 'importing', done, total: all, preview });
        },
      });
      setStage({ step: 'done', result, preview });
      toast.push(
        t('import.done_toast', {
          created: result.created,
          updated: result.updated,
        }),
        'info',
      );
    } catch {
      setStage({ step: 'choose' });
      toast.push(t('import.import_failed'), 'error');
    }
  };

  return (
    <Box mx="auto" maw={1024} p="md" w="100%">
      <Stack gap="md">
        <SubpageHeader
          backTo="/products"
          backLabel={t('import.back_to_products')}
          icon={<ProductsIcon />}
          title={t('import.title')}
        />
        <Group
          component="ol"
          gap="sm"
          wrap="wrap"
          aria-label={t('import.steps')}
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {(['choose', 'map', 'preview', 'importing'] as const).map((s, i) => {
            const active =
              stage.step === s || (s === 'importing' && stage.step === 'done');
            return (
              <Group
                component="li"
                key={s}
                gap={8}
                aria-current={active ? 'step' : undefined}
                wrap="nowrap"
              >
                <ThemeIcon
                  size={24}
                  radius="xl"
                  variant={active ? 'filled' : 'light'}
                  color={active ? 'brand' : 'gray'}
                >
                  <Text size="xs" fw={600}>
                    {i + 1}
                  </Text>
                </ThemeIcon>
                <Text
                  size="sm"
                  fw={active ? 600 : undefined}
                  c={active ? undefined : 'dimmed'}
                >
                  {t(`import.step_${s}`)}
                </Text>
                {i < 3 ? (
                  <Text aria-hidden="true" c="dimmed">
                    ›
                  </Text>
                ) : null}
              </Group>
            );
          })}
        </Group>

        {stage.step === 'choose' ? (
          <Paper withBorder p="lg">
            <Stack gap="sm">
              <Text>
                {t('import.choose_hint', {
                  max: MAX_IMPORT_ROWS.toLocaleString('en'),
                })}
              </Text>
              <Box>
                <Button component="label" htmlFor={fileId} variant="default">
                  {t('import.choose_file')}
                </Button>
                <input
                  id={fileId}
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  className="sr-only"
                  onChange={(event) => void onFile(event.target.files?.[0])}
                />
                {fileName ? (
                  <Text size="sm" c="dimmed" mt={4}>
                    {fileName}
                  </Text>
                ) : null}
              </Box>
              {readError ? (
                <Text c="danger" role="alert" size="sm">
                  {readError}
                </Text>
              ) : null}
              <Button
                type="button"
                variant="default"
                onClick={() => downloadText(TEMPLATE_FILE, templateCsv())}
                style={{ alignSelf: 'flex-start' }}
              >
                {t('import.template')}
              </Button>
            </Stack>
          </Paper>
        ) : null}

        {stage.step === 'map' ? (
          <MapColumns
            headers={stage.grid[0] ?? []}
            mapping={stage.mapping}
            rows={stage.grid.length - 1}
            file={stage.file}
            onChange={(mapping) => setStage({ ...stage, mapping })}
            onBack={() => setStage({ step: 'choose' })}
            onNext={() => void toPreview(stage.grid, stage.mapping, stage.file)}
          />
        ) : null}

        {stage.step === 'preview' ? (
          <Stack gap="sm">
            <Text role="status" fz="lg" data-testid="import-summary">
              {t('import.summary', {
                created: stage.preview.summary.new,
                updated: stage.preview.summary.updates,
                errors: stage.preview.summary.errors,
              })}
            </Text>
            {stage.preview.rows.some((r) => r.ignored.length > 0) ? (
              <Text c="dimmed">{t('import.ignored_note')}</Text>
            ) : null}
            <PreviewTable preview={stage.preview} message={message} />
            <Group justify="flex-end" gap="sm">
              <Button
                type="button"
                variant="default"
                onClick={() =>
                  setStage({
                    step: 'map',
                    grid: stage.grid,
                    mapping: stage.mapping,
                    file: stage.file,
                  })
                }
              >
                {t('import.back')}
              </Button>
              {stage.preview.summary.errors > 0 ? (
                <Button
                  type="button"
                  variant="default"
                  onClick={() => downloadErrors(stage.preview)}
                >
                  {t('import.download_errors')}
                </Button>
              ) : null}
              <Button
                type="button"
                disabled={
                  stage.preview.summary.new + stage.preview.summary.updates ===
                  0
                }
                onClick={() => void doImport(stage.preview)}
              >
                {t('import.import_rows', {
                  count:
                    stage.preview.summary.new + stage.preview.summary.updates,
                })}
              </Button>
            </Group>
          </Stack>
        ) : null}

        {stage.step === 'importing' ? (
          <Paper withBorder p="lg">
            <Stack gap="sm">
              <Text>
                {t('import.importing', {
                  done: stage.done,
                  total: stage.total,
                })}
              </Text>
              <Progress
                value={(stage.done / Math.max(1, stage.total)) * 100}
                size="md"
                aria-label={t('import.progress')}
              />
            </Stack>
          </Paper>
        ) : null}

        {stage.step === 'done' ? (
          <Paper withBorder p="lg">
            <Stack gap="sm">
              <Text role="status" fz="lg" data-testid="import-result">
                {t('import.result', {
                  created: stage.result.created,
                  updated: stage.result.updated,
                  skipped: stage.result.skipped,
                })}
              </Text>
              <Group gap="sm">
                <Link to="/products" style={{ textDecoration: 'none' }}>
                  <Button component="span">
                    {t('import.back_to_products')}
                  </Button>
                </Link>
                {stage.result.skipped > 0 ? (
                  <Button
                    type="button"
                    variant="default"
                    onClick={() => downloadErrors(stage.preview)}
                  >
                    {t('import.download_errors')}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setStage({ step: 'choose' })}
                >
                  {t('import.another')}
                </Button>
              </Group>
            </Stack>
          </Paper>
        ) : null}
      </Stack>
    </Box>
  );
}

function MapColumns({
  headers,
  mapping,
  rows,
  file,
  onChange,
  onBack,
  onNext,
}: {
  headers: string[];
  mapping: Mapping;
  rows: number;
  file: string;
  onChange: (m: Mapping) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const base = useId();
  const canMatch =
    mapping.name_en !== undefined ||
    mapping.sku !== undefined ||
    mapping.barcode !== undefined;
  const set = (field: ImportField, value: string) => {
    const next = { ...mapping };
    if (value === '') delete next[field];
    else next[field] = Number(value);
    onChange(next);
  };
  return (
    <Stack gap="sm">
      <Text>{t('import.map_hint', { file, count: rows })}</Text>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
        {TEMPLATE_COLUMNS.map((field) => (
          <NativeSelect
            key={field}
            id={`${base}-${field}`}
            label={t(`import.field.${field}`)}
            value={mapping[field] === undefined ? '' : String(mapping[field])}
            onChange={(event) => set(field, event.currentTarget.value)}
            data={[
              { value: '', label: t('import.not_in_file') },
              ...headers.map((h, i) => ({
                value: String(i),
                label: h || t('import.column_n', { n: i + 1 }),
              })),
            ]}
          />
        ))}
      </SimpleGrid>
      {canMatch ? null : (
        <Text c="danger" role="alert" size="sm">
          {t('import.need_name')}
        </Text>
      )}
      <Group justify="flex-end" gap="sm">
        <Button type="button" variant="default" onClick={onBack}>
          {t('import.back')}
        </Button>
        <Button type="button" disabled={!canMatch} onClick={onNext}>
          {t('import.to_preview')}
        </Button>
      </Group>
    </Stack>
  );
}

function PreviewTable({
  preview,
  message,
}: {
  preview: ImportPreview;
  message: (e: RowError) => string;
}) {
  const { t } = useTranslation();
  const shown = preview.rows.slice(0, PREVIEW_LIMIT);
  return (
    <Paper withBorder>
      <Box
        tabIndex={0}
        role="region"
        aria-label={t('import.step_preview')}
        style={{ overflowX: 'auto' }}
      >
        <Table fz="sm" miw={640}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('import.col_line')}</Table.Th>
              <Table.Th>{t('import.field.name_en')}</Table.Th>
              <Table.Th ta="end">{t('import.field.price')}</Table.Th>
              <Table.Th>{t('import.col_action')}</Table.Th>
              <Table.Th>{t('import.col_errors')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {shown.map((r) => (
              <Table.Tr key={r.line} data-testid="import-row">
                <Table.Td>{r.line}</Table.Td>
                <Table.Td>{r.parsed.name_en}</Table.Td>
                <Table.Td ta="end">
                  {r.parsed.price === null ? (
                    ''
                  ) : (
                    <MoneyText paisa={r.parsed.price} />
                  )}
                </Table.Td>
                <Table.Td>{t(`import.action_${r.action}`)}</Table.Td>
                <Table.Td
                  bg={
                    r.errors.length
                      ? 'var(--mantine-color-danger-subtle)'
                      : undefined
                  }
                  c={
                    r.errors.length
                      ? 'var(--mantine-color-danger-subtle-ink)'
                      : undefined
                  }
                >
                  {r.errors.map(message).join(' · ')}
                  {r.ignored.length > 0 ? t('import.ignored_cells') : ''}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Box>
      {preview.rows.length > PREVIEW_LIMIT ? (
        <Text size="sm" c="dimmed" p="xs">
          {t('import.more_rows', {
            count: preview.rows.length - PREVIEW_LIMIT,
          })}
        </Text>
      ) : null}
    </Paper>
  );
}
