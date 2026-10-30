import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { CloudIcon } from '../components/icons.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { deviceInfo } from '../data/localTenant.ts';
import {
  buildServerExport,
  clearServerExportSession,
} from '../data/serverExport.ts';
import {
  buildShopExport,
  type ShopExportProgress,
} from '../data/shopExport.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { downloadBlob } from '../print/receiptImage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { OwnerSigninRequired } from '../sync/shopApi.ts';
import { SettingsPageLayout } from './Layout.tsx';
import { shopErrorMessage, useShopAdmin } from './OwnerSignin.tsx';

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
  const { staff, can, role } = useCurrentStaff();
  const db = getDb();
  const device = useLiveQuery(() => deviceInfo(db), []);
  const enrolled = useLiveQuery(
    async () => Boolean((await db.kv.get('device_token'))?.value),
    [],
  );
  const { run, dialog } = useShopAdmin(db, staff?.id ?? null);
  const serverAllowed =
    can('export.data') &&
    role === 'owner' &&
    device?.is_admin === true &&
    enrolled;
  const [building, setBuilding] = useState(false);
  const [progress, setProgress] = useState<ShopExportProgress | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [serverBuilding, setServerBuilding] = useState(false);
  const [serverDone, setServerDone] = useState<string | null>(null);
  const [serverProgress, setServerProgress] = useState<string | null>(null);

  if (!can('export.data') || role !== 'owner')
    return (
      <SettingsPageLayout title={t('office.backup.title')} icon={<CloudIcon />}>
        <p className="p-6 text-center text-text-muted">
          {t('office.backup.no_permission')}
        </p>
      </SettingsPageLayout>
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

  const downloadServer = async () => {
    if (!serverAllowed || serverBuilding || !staff) return;
    setServerBuilding(true);
    setServerDone(null);
    setServerProgress(null);
    try {
      await run(async () => {
        const result = await buildServerExport(db, staff.id, {
          onProgress: (progress) =>
            setServerProgress(
              `${progress.table} (${progress.done}/${progress.rows})`,
            ),
        });
        downloadBlob(
          new Blob([result.bytes as BlobPart], { type: 'application/zip' }),
          result.filename,
        );
        clearServerExportSession();
        setServerDone(result.filename);
        toast.push(t('office.backup.server_done'));
      });
    } catch (error) {
      if (error instanceof OwnerSigninRequired) return;
      toast.push(shopErrorMessage(t, error), 'error');
    } finally {
      setServerBuilding(false);
      setServerProgress(null);
    }
  };

  return (
    <SettingsPageLayout title={t('office.backup.title')} icon={<CloudIcon />}>
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
        <p className="mt-3 text-small text-text-muted">
          {t('office.backup.includes')}
        </p>
      </section>

      <section className="rounded-card border border-border bg-surface p-4">
        <h2 className="text-title font-semibold">
          {t('office.backup.server')}
        </h2>
        <p className="mt-1 text-small text-text-muted">
          {serverAllowed
            ? t('office.backup.server_hint')
            : t('office.backup.server_unavailable')}
        </p>
        <button
          type="button"
          className={buttonQuiet}
          disabled={!serverAllowed || serverBuilding}
          aria-busy={serverBuilding}
          onClick={() => void downloadServer()}
        >
          {serverBuilding
            ? t('office.backup.server_building')
            : t('office.backup.server')}
        </button>
        {serverProgress ? (
          <p className="mt-1 text-small text-text-muted">{serverProgress}</p>
        ) : null}
        {serverDone ? (
          <p className="mt-1 text-small text-success-subtle-ink" role="status">
            {t('office.backup.server_finished', { filename: serverDone })}
          </p>
        ) : null}
      </section>
      {dialog}

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
    </SettingsPageLayout>
  );
}
