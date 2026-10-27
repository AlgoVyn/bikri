import { Link, Navigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
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

const selectClass =
  'h-11 min-w-0 rounded-control border border-border-strong bg-surface px-2 text-text';
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
  const fileId = useId();
  if (!can('catalog.edit')) return <Navigate to="/products" replace />;

  const message = (e: RowError) =>
    t(`import.err.${e.code}`, { name: e.name ?? '', max: MAX_IMPORT_ROWS });
  const downloadErrors = (preview: ImportPreview) =>
    downloadText('import-errors.csv', errorsCsv(preview, message));

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReadError(null);
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
    const ctx = await ledgerContext(getDb(), staff?.id ?? '');
    const result = await runImport(getDb(), preview, ctx, {
      onProgress: (done, all) =>
        setStage({ step: 'importing', done, total: all, preview }),
    });
    setStage({ step: 'done', result, preview });
    toast.push(
      t('import.done_toast', {
        created: result.created,
        updated: result.updated,
      }),
      'info',
    );
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-h1 font-semibold">{t('import.title')}</h1>
        <Link to="/products" className={buttonQuiet}>
          {t('import.back_to_products')}
        </Link>
      </div>
      <ol
        className="flex flex-wrap gap-3 text-small text-text-muted"
        aria-label={t('import.steps')}
      >
        {(['choose', 'map', 'preview', 'importing'] as const).map((s, i) => (
          <li
            key={s}
            aria-current={
              stage.step === s || (s === 'importing' && stage.step === 'done')
                ? 'step'
                : undefined
            }
            className="aria-[current=step]:font-semibold aria-[current=step]:text-text"
          >
            {i + 1}. {t(`import.step_${s}`)}
          </li>
        ))}
      </ol>

      {stage.step === 'choose' ? (
        <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
          <p>
            {t('import.choose_hint', {
              max: MAX_IMPORT_ROWS.toLocaleString('en'),
            })}
          </p>
          <label htmlFor={fileId} className="font-medium">
            {t('import.choose_file')}
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="min-h-11"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          {readError ? (
            <p role="alert" className="text-danger">
              {readError}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => downloadText(TEMPLATE_FILE, templateCsv())}
            >
              {t('import.template')}
            </button>
          </div>
        </section>
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
        <section className="flex flex-col gap-3">
          <p role="status" className="text-title" data-testid="import-summary">
            {t('import.summary', {
              created: stage.preview.summary.new,
              updated: stage.preview.summary.updates,
              errors: stage.preview.summary.errors,
            })}
          </p>
          {stage.preview.rows.some((r) => r.ignored.length > 0) ? (
            <p className="text-text-muted">{t('import.ignored_note')}</p>
          ) : null}
          <PreviewTable preview={stage.preview} message={message} />
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className={buttonQuiet}
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
            </button>
            {stage.preview.summary.errors > 0 ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => downloadErrors(stage.preview)}
              >
                {t('import.download_errors')}
              </button>
            ) : null}
            <button
              type="button"
              className={buttonPrimary}
              disabled={
                stage.preview.summary.new + stage.preview.summary.updates === 0
              }
              onClick={() => void doImport(stage.preview)}
            >
              {t('import.import_rows', {
                count:
                  stage.preview.summary.new + stage.preview.summary.updates,
              })}
            </button>
          </div>
        </section>
      ) : null}

      {stage.step === 'importing' ? (
        <section className="flex flex-col gap-2">
          <p>
            {t('import.importing', { done: stage.done, total: stage.total })}
          </p>
          <progress
            className="h-3 w-full"
            aria-label={t('import.progress')}
            max={Math.max(1, stage.total)}
            value={stage.done}
          />
        </section>
      ) : null}

      {stage.step === 'done' ? (
        <section className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
          <p role="status" className="text-title" data-testid="import-result">
            {t('import.result', {
              created: stage.result.created,
              updated: stage.result.updated,
              skipped: stage.result.skipped,
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link to="/products" className={buttonPrimary}>
              {t('import.back_to_products')}
            </Link>
            {stage.result.skipped > 0 ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => downloadErrors(stage.preview)}
              >
                {t('import.download_errors')}
              </button>
            ) : null}
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => setStage({ step: 'choose' })}
            >
              {t('import.another')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
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
    <section className="flex flex-col gap-3">
      <p>{t('import.map_hint', { file, count: rows })}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {TEMPLATE_COLUMNS.map((field) => (
          <label
            key={field}
            htmlFor={`${base}-${field}`}
            className="flex flex-col gap-1"
          >
            <span className="text-small font-medium">
              {t(`import.field.${field}`)}
            </span>
            <select
              id={`${base}-${field}`}
              className={selectClass}
              value={mapping[field] === undefined ? '' : String(mapping[field])}
              onChange={(e) => set(field, e.target.value)}
            >
              <option value="">{t('import.not_in_file')}</option>
              {headers.map((h, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are identified by position
                <option key={i} value={String(i)}>
                  {h || t('import.column_n', { n: i + 1 })}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {canMatch ? null : (
        <p role="alert" className="text-danger">
          {t('import.need_name')}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={buttonQuiet} onClick={onBack}>
          {t('import.back')}
        </button>
        <button
          type="button"
          className={buttonPrimary}
          disabled={!canMatch}
          onClick={onNext}
        >
          {t('import.to_preview')}
        </button>
      </div>
    </section>
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
    <div className="overflow-x-auto rounded-card border border-border">
      <table className="w-full text-start text-small">
        <thead className="bg-surface-2">
          <tr>
            <th className="px-2 py-2 text-start">{t('import.col_line')}</th>
            <th className="px-2 py-2 text-start">
              {t('import.field.name_en')}
            </th>
            <th className="px-2 py-2 text-end">{t('import.field.price')}</th>
            <th className="px-2 py-2 text-start">{t('import.col_action')}</th>
            <th className="px-2 py-2 text-start">{t('import.col_errors')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r) => (
            <tr
              key={r.line}
              data-testid="import-row"
              className="border-t border-border"
            >
              <td className="px-2 py-1">{r.line}</td>
              <td className="px-2 py-1">{r.parsed.name_en}</td>
              <td className="px-2 py-1 text-end">
                {r.parsed.price === null ? (
                  ''
                ) : (
                  <MoneyText paisa={r.parsed.price} />
                )}
              </td>
              <td className="px-2 py-1">{t(`import.action_${r.action}`)}</td>
              <td
                className={`px-2 py-1 ${r.errors.length ? 'bg-danger-subtle text-danger-subtle-ink' : ''}`}
              >
                {r.errors.map(message).join(' · ')}
                {r.ignored.length > 0 ? t('import.ignored_cells') : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {preview.rows.length > PREVIEW_LIMIT ? (
        <p className="p-2 text-small text-text-muted">
          {t('import.more_rows', {
            count: preview.rows.length - PREVIEW_LIMIT,
          })}
        </p>
      ) : null}
    </div>
  );
}
