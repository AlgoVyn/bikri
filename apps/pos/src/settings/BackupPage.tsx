import { Box, Button, Progress, Stack, Text, Title } from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
        <Text p="lg" ta="center" c="dimmed">
          {t('office.backup.no_permission')}
        </Text>
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
      <Box component="section">
        <Stack gap="sm">
          <Text>{t('office.backup.nightly')}</Text>
          <Text size="sm" c="dimmed">
            {t('office.backup.hint')}
          </Text>
          <Button
            type="button"
            disabled={building}
            aria-busy={building}
            loading={building}
            onClick={() => void download()}
            style={{ alignSelf: 'flex-start' }}
          >
            {building
              ? t('office.backup.building')
              : t('office.backup.download')}
          </Button>
          {building && progress ? (
            <Stack gap={4}>
              <Progress
                value={((progress.index + 1) / progress.total) * 100}
                size="sm"
                aria-label={t('office.backup.progress', {
                  table: progress.table,
                  index: progress.index + 1,
                  total: progress.total,
                  rows: progress.rows,
                })}
              />
              <Text size="sm" c="dimmed">
                {t('office.backup.progress', {
                  table: progress.table,
                  index: progress.index + 1,
                  total: progress.total,
                  rows: progress.rows,
                })}
              </Text>
            </Stack>
          ) : null}
          {done ? (
            <Text size="sm" c="var(--color-success)" role="status">
              {t('office.backup.finished', { filename: done })}
            </Text>
          ) : null}
          <Text size="sm" c="dimmed">
            {t('office.backup.includes')}
          </Text>
        </Stack>
      </Box>

      <Box component="section">
        <Stack gap="sm">
          <Title order={2} fz="lg">
            {t('office.backup.server')}
          </Title>
          <Text size="sm" c="dimmed">
            {serverAllowed
              ? t('office.backup.server_hint')
              : t('office.backup.server_unavailable')}
          </Text>
          <Button
            type="button"
            variant="default"
            disabled={!serverAllowed || serverBuilding}
            aria-busy={serverBuilding}
            loading={serverBuilding}
            onClick={() => void downloadServer()}
            style={{ alignSelf: 'flex-start' }}
          >
            {serverBuilding
              ? t('office.backup.server_building')
              : t('office.backup.server')}
          </Button>
          {serverProgress ? (
            <Text size="sm" c="dimmed">
              {serverProgress}
            </Text>
          ) : null}
          {serverDone ? (
            <Text size="sm" c="var(--color-success)" role="status">
              {t('office.backup.server_finished', { filename: serverDone })}
            </Text>
          ) : null}
        </Stack>
      </Box>
      {dialog}

      <Box component="section">
        <Stack gap="sm">
          <Title order={2} fz="lg">
            {t('office.backup.restore')}
          </Title>
          <Text size="sm" c="dimmed">
            {t('office.backup.restore_hint')}
          </Text>
          <Button
            type="button"
            variant="default"
            disabled
            style={{ alignSelf: 'flex-start' }}
          >
            {t('office.backup.restore')}
          </Button>
        </Stack>
      </Box>
    </SettingsPageLayout>
  );
}
