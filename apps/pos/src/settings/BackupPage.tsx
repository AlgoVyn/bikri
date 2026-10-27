import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import {
  buildShopExport,
  SHOP_EXPORT_TABLES,
  type ShopExportProgress,
} from '../data/shopExport.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { downloadBlob } from '../print/receiptImage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

/** Settings → Backup and export (screens/17); the server copy arrives with T-053. */
export function BackupPage() {
  return (
    <AreaStrings area="office">
      <BackupContent />
    </AreaStrings>
  );
}

function BackupContent() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useCurrentStaff();
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<ShopExportProgress | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!can('export.data'))
    return (
      <p className="p-6 text-center text-text-muted">
        {t('office.backup.no_permission')}
      </p>
    );

  const download = async () => {
    if (building) return;
    setBuilding(true);
    setDone(null);
    setProgress(null);
    try {
      const result = await buildShopExport(getDb(), {
        onProgress: setProgress,
      });
      downloadBlob(
        new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
        result.filename,
      );
      setDone(result.filename);
      toast.push(t('office.backup.done'));
    } catch {
      toast.push(t('office.backup.error'), 'error');
    } finally {
      setBuilding(false);
      setProgress(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-4">
      <h1 className="text-h1 font-semibold">{t('office.backup.title')}</h1>
      <section className="rounded-card border border-border bg-surface p-4">
        <p>{t('office.backup.nightly')}</p>
        <p className="mt-1 text-small text-text-muted">
          {t('office.backup.hint')}
        </p>
        <button
          type="button"
          className={`${buttonPrimary} mt-3`}
          disabled={building}
          aria-busy={building}
          onClick={() => void download()}
        >
          {building ? t('office.backup.building') : t('office.backup.download')}
        </button>
        {building && progress ? (
          <div className="mt-3 flex flex-col gap-1">
            <progress
              className="h-2 w-full"
              max={progress.total}
              value={progress.index + 1}
            />
            <p className="text-small text-text-muted">
              {t('office.backup.progress', {
                table: progress.table,
                index: progress.index + 1,
                total: progress.total,
                rows: progress.rows,
              })}
            </p>
          </div>
        ) : null}
        {done ? (
          <p className="mt-2 text-small text-success-subtle-ink" role="status">
            {t('office.backup.finished', { filename: done })}
          </p>
        ) : null}
        <ul className="mt-3 columns-2 text-small text-text-muted">
          {SHOP_EXPORT_TABLES.map((table) => (
            <li key={table}>{table}</li>
          ))}
        </ul>
      </section>

      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">
          {t('office.backup.server')}
        </h2>
        <p className="mt-1 text-small text-text-muted">
          {t('office.backup.server_hint')}
        </p>
        <button type="button" className={buttonQuiet} disabled>
          {t('office.backup.server')}
        </button>
      </section>

      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">
          {t('office.backup.restore')}
        </h2>
        <p className="mt-1 text-small text-text-muted">
          {t('office.backup.restore_hint')}
        </p>
        <button type="button" className={buttonQuiet} disabled>
          {t('office.backup.restore')}
        </button>
      </section>
    </div>
  );
}
