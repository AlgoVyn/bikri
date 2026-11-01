import { Link, Navigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { CheckIcon, ProductsIcon, UploadIcon } from '../components/icons.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { TaskAside, TaskLayout } from '../components/TaskLayout.tsx';
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
import { ReadOnlyError } from '../data/write.ts';
import { downloadText } from '../lib/download.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
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
  const readOnly = useReadOnly();
  const [stage, setStage] = useState<Stage>({ step: 'choose' });
  const [readError, setReadError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileId = useId();
  if (!can('catalog.edit')) return <Navigate to="/products" replace />;
  if (readOnly)
    return (
      <div className="mx-auto flex max-w-lg flex-col items-center gap-3 p-8 text-center">
        <p className="text-text-muted">{t('tenant.readOnly.blocked')}</p>
        <Link to="/products" className={buttonQuiet}>
          {t('office.products.title')}
        </Link>
      </div>
    );

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
    } catch (err) {
      setStage({ step: 'choose' });
      toast.push(
        err instanceof ReadOnlyError
          ? t('tenant.readOnly.blocked')
          : t('import.import_failed'),
        'error',
      );
    }
  };

  return (
    <div className={pageClass('standard', 'gap-4')}>
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<ProductsIcon />}
        title={t('import.title')}
      />
      <ol className="flex flex-wrap gap-2" aria-label={t('import.steps')}>
        {(['choose', 'map', 'preview', 'importing'] as const).map((s, i) => {
          const active =
            stage.step === s || (s === 'importing' && stage.step === 'done');
          const done =
            i <
            (stage.step === 'done'
              ? 3
              : ['choose', 'map', 'preview', 'importing'].indexOf(stage.step));
          return (
            <li
              key={s}
              aria-current={active ? 'step' : undefined}
              className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-small ${
                active
                  ? 'border-primary bg-primary font-semibold text-primary-ink'
                  : done
                    ? 'border-success-subtle bg-success-subtle text-success-subtle-ink'
                    : 'border-border bg-surface text-text-muted'
              }`}
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-white/20 text-caption font-semibold">
                {done ? <CheckIcon className="size-3.5" /> : i + 1}
              </span>
              {t(`import.step_${s}`)}
            </li>
          );
        })}
      </ol>

      <TaskLayout
        aside={
          <TaskAside
            title={t('import.help_title')}
            items={[t('import.help_1'), t('import.help_2'), t('import.help_3')]}
          />
        }
      >
        {stage.step === 'choose' ? (
          <fieldset
            className="m-0 flex min-w-0 flex-col items-center gap-3 rounded-card border-2 border-dashed border-border-strong bg-surface px-6 py-10 text-center transition-colors duration-150 data-[dragging=true]:border-primary data-[dragging=true]:bg-primary-subtle/40"
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void onFile(event.dataTransfer.files?.[0]);
            }}
            data-dragging={dragging}
          >
            <span
              aria-hidden="true"
              className="flex size-12 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink"
            >
              <UploadIcon />
            </span>
            <div>
              <p className="text-title font-semibold">
                {t('import.drop_title')}
              </p>
              <p className="mt-1 text-small text-text-muted">
                {t('import.drop_hint')}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <label htmlFor={fileId} className={buttonPrimary}>
                {t('import.choose_file')}
              </label>
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => downloadText(TEMPLATE_FILE, templateCsv())}
              >
                {t('import.template')}
              </button>
            </div>
            <p className="max-w-md text-small text-text-muted">
              {t('import.choose_hint', {
                max: MAX_IMPORT_ROWS.toLocaleString('en'),
              })}
            </p>
            <input
              id={fileId}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={(e) => void onFile(e.target.files?.[0])}
            />
            {fileName ? (
              <p className="text-small text-text-muted">{fileName}</p>
            ) : null}
            {readError ? (
              <p role="alert" className="text-danger">
                {readError}
              </p>
            ) : null}
          </fieldset>
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
            <p
              role="status"
              className="text-title"
              data-testid="import-summary"
            >
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
                  stage.preview.summary.new + stage.preview.summary.updates ===
                  0
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
      </TaskLayout>
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
          <div key={field} className="flex flex-col gap-1">
            <label
              htmlFor={`${base}-${field}`}
              className="text-small font-medium"
            >
              {t(`import.field.${field}`)}
            </label>
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
          </div>
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
