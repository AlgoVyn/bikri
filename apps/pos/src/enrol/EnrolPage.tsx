/** Enrol this device (screens/02, T-034). Rendered by the gate without the app shell. */
import type { BikriDb } from '@bikri/db';
import {
  Box,
  Button,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrandMark } from '../components/BrandMark.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import {
  CODE_RE,
  defaultDeviceName,
  enrolDevice,
  formatCode,
  leaveShop,
  markUnsyncedExported,
  normaliseCodeInput,
  UnsyncedOpsError,
  unexportedOps,
  unsyncedExport,
} from '../data/enrol.ts';
import { OfflineError, SyncHttpError } from '../sync/client.ts';
import { pullAll } from '../sync/pull.ts';

export type EnrolPageProps = {
  /** The database this browser is connected to, if any (already-connected and revoked views). */
  db: BikriDb | null;
  shopName: string | null;
  revoked: boolean;
  /** Go to the app after a finished download (reloads so every module sees the new shop). */
  onDone?: () => void;
};

let urlCode: string | null = null;

/** Reads `?code=` once (StrictMode runs initialisers twice) and removes it from the address bar. */
function codeFromUrl(): string {
  if (urlCode !== null) return urlCode;
  if (typeof window === 'undefined') return '';
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  if (!code) return '';
  urlCode = normaliseCodeInput(code);
  url.searchParams.delete('code');
  window.history.replaceState(window.history.state, '', url.toString());
  return normaliseCodeInput(code);
}

function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

function reloadHome(): void {
  window.location.assign(import.meta.env.BASE_URL || '/');
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportUnsynced(db: BikriDb): Promise<void> {
  const file = await unsyncedExport(db);
  downloadJson(file.filename, file.data);
  await markUnsyncedExported(db);
}

type Stage =
  | { kind: 'form' }
  | {
      kind: 'downloading';
      shop: string;
      db: BikriDb;
      done: number;
      total: number;
    }
  | { kind: 'failed'; shop: string; db: BikriDb; message: string }
  | { kind: 'left'; shop: string };

export function EnrolPage({
  db,
  shopName,
  revoked,
  onDone = reloadHome,
}: EnrolPageProps) {
  const { t } = useTranslation();
  const online = useOnline();
  const [initialCode] = useState(codeFromUrl);
  const [tab, setTab] = useState<'code' | 'new'>('code');
  const [code, setCode] = useState(initialCode);
  // Empty keeps the name the owner put on the code (D-107); the placeholder suggests one.
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const [connected, setConnected] = useState<{
    db: BikriDb;
    shop: string;
  } | null>(db && shopName && !revoked ? { db, shop: shopName } : null);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const download = async (target: BikriDb, shop: string) => {
    setStage({ kind: 'downloading', shop, db: target, done: 0, total: 0 });
    try {
      await pullAll(target, (done, total) =>
        setStage({ kind: 'downloading', shop, db: target, done, total }),
      );
      onDone();
    } catch (e) {
      setStage({
        kind: 'failed',
        shop,
        db: target,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const connect = async () => {
    const normalised = normaliseCodeInput(code);
    if (!CODE_RE.test(normalised)) {
      setError(t('enrol.err_code'));
      return;
    }
    if (revoked && db) {
      const count = await unexportedOps(db);
      if (count > 0) {
        setError(t('enrol.leave_blocked', { count }));
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const { db: target, res } = await enrolDevice(normalised, name.trim());
      void download(target, res.tenant.display_name);
    } catch (e) {
      if (e instanceof OfflineError) setError(t('enrol.err_offline'));
      else if (e instanceof SyncHttpError) {
        if (e.code === 'BAD_ENROLMENT_CODE') setError(t('enrol.err_bad'));
        else if (e.code === 'TENANT_SUSPENDED')
          setError(t('enrol.err_suspended'));
        else if (e.code === 'RATE_LIMITED') setError(t('enrol.err_rate'));
        else setError(t('enrol.err_other', { message: e.message || e.code }));
      } else setError(t('enrol.err_other', { message: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const leave = async (target: BikriDb, after: Stage | null) => {
    setLeaveError(null);
    try {
      await leaveShop(target);
      setConnected(null);
      setConfirmLeave(false);
      if (after) setStage(after);
      else setStage({ kind: 'form' });
    } catch (e) {
      if (e instanceof UnsyncedOpsError)
        setLeaveError(t('enrol.leave_blocked', { count: e.count }));
      else setLeaveError(String(e));
    }
  };

  const card = (body: React.ReactNode) => (
    <Box
      component="main"
      mih="100dvh"
      bg="var(--mantine-color-body)"
      p="md"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Paper withBorder shadow="sm" p="lg" w="100%" maw={460}>
        <Group justify="space-between" align="center" gap="sm">
          <Group gap="sm" wrap="nowrap">
            <BrandMark size={36} />
            <Text size="lg" fw={700}>
              {t('common.app_name')}
            </Text>
          </Group>
          <LanguageSelect />
        </Group>
        <Stack gap="md" mt="md">
          {body}
        </Stack>
      </Paper>
    </Box>
  );

  if (stage.kind === 'downloading' || stage.kind === 'failed') {
    const pct =
      stage.kind === 'downloading' && stage.total > 0
        ? Math.round((stage.done / stage.total) * 100)
        : 0;
    return card(
      <>
        <Text role="status">{t('enrol.connected', { shop: stage.shop })}</Text>
        {stage.kind === 'downloading' ? (
          <>
            <Text size="sm" c="dimmed">
              {stage.total > 0
                ? t('enrol.downloading_count', {
                    done: stage.done.toLocaleString(),
                    total: stage.total.toLocaleString(),
                  })
                : t('enrol.downloading')}
            </Text>
            <Progress
              value={pct}
              size="sm"
              aria-label={t('enrol.downloading')}
            />
          </>
        ) : (
          <>
            <Text role="alert" c="danger">
              {t('enrol.download_failed', { message: stage.message })}
            </Text>
            <Button
              type="button"
              onClick={() => void download(stage.db, stage.shop)}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('enrol.retry')}
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="transparent"
          size="compact-sm"
          px={0}
          onClick={() =>
            void leave(stage.db, { kind: 'left', shop: stage.shop })
          }
          style={{ alignSelf: 'flex-start' }}
        >
          {t('enrol.not_mine')}
        </Button>
        {leaveError ? (
          <Text role="alert" c="danger" size="sm">
            {leaveError}
          </Text>
        ) : null}
      </>,
    );
  }

  if (connected) {
    return card(
      <>
        <Title order={2}>{t('enrol.already', { shop: connected.shop })}</Title>
        <Button
          type="button"
          onClick={onDone}
          style={{ alignSelf: 'flex-start' }}
        >
          {t('enrol.open', { shop: connected.shop })}
        </Button>
        {confirmLeave ? (
          <Paper withBorder p="sm">
            <Stack gap="sm">
              <Text>{t('enrol.leave_confirm', { shop: connected.shop })}</Text>
              <Group gap="sm">
                <Button
                  type="button"
                  color="danger"
                  onClick={() => void leave(connected.db, null)}
                >
                  {t('enrol.leave')}
                </Button>
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setConfirmLeave(false)}
                >
                  {t('common.cancel')}
                </Button>
              </Group>
            </Stack>
          </Paper>
        ) : (
          <Button
            type="button"
            variant="default"
            onClick={() => setConfirmLeave(true)}
            style={{ alignSelf: 'flex-start' }}
          >
            {t('enrol.leave')}
          </Button>
        )}
        {leaveError ? (
          <Stack gap="sm">
            <Text role="alert" c="danger" size="sm">
              {leaveError}
            </Text>
            <Button
              type="button"
              variant="default"
              onClick={() => void exportUnsynced(connected.db)}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('enrol.export_unsynced')}
            </Button>
          </Stack>
        ) : null}
      </>,
    );
  }

  const codeError = error;
  return card(
    <>
      <Title order={2}>{t('enrol.heading')}</Title>
      {stage.kind === 'left' ? (
        <p role="status" className="text-small">
          {t('enrol.not_mine_help', { shop: stage.shop })}
        </p>
      ) : null}
      <Group gap="sm" role="tablist">
        {(['code', 'new'] as const).map((id) => (
          <Button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            variant={tab === id ? 'filled' : 'default'}
            onClick={() => setTab(id)}
          >
            {t(id === 'code' ? 'enrol.tab_code' : 'enrol.tab_new')}
          </Button>
        ))}
      </Group>
      {tab === 'new' ? (
        <p className="text-small">{t('enrol.new_shop_help')}</p>
      ) : null}
      <Box
        component="form"
        noValidate
        onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void connect();
        }}
      >
        <TextInput
          label={t('enrol.code_label')}
          value={formatCode(code)}
          onChange={(e) => {
            setCode(normaliseCodeInput(e.currentTarget.value));
            setError(null);
          }}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          maxLength={9}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? 'enrol-error' : undefined}
          placeholder="ABCD-EFGH"
          styles={{
            input: { textTransform: 'uppercase', letterSpacing: '0.12em' },
          }}
        />
        <TextInput
          label={t('enrol.name_label')}
          value={name}
          maxLength={60}
          placeholder={defaultDeviceName()}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {codeError ? (
          <Text id="enrol-error" role="alert" c="danger" size="sm">
            {codeError}
          </Text>
        ) : null}
        {!online ? (
          <Text size="sm" c="dimmed">
            {t('enrol.err_offline')}
          </Text>
        ) : null}
        <Button
          type="submit"
          fullWidth
          loading={busy}
          disabled={!online || busy}
        >
          {busy ? t('enrol.connecting') : t('enrol.connect')}
        </Button>
      </Box>
      {tab === 'new' ? (
        <Box component="details">
          <Text
            component="summary"
            size="sm"
            c="var(--mantine-color-brand-7)"
            style={{ cursor: 'pointer' }}
          >
            {t('enrol.privacy_link')}
          </Text>
          <Text size="sm" mt="xs">
            {t('enrol.privacy_text')}
          </Text>
        </Box>
      ) : null}
      {revoked && db ? (
        <Paper withBorder p="sm">
          <Stack gap="sm">
            <Text>{t('enrol.revoked')}</Text>
            <Button
              type="button"
              variant="default"
              onClick={() => void exportUnsynced(db)}
              style={{ alignSelf: 'flex-start' }}
            >
              {t('enrol.export_unsynced')}
            </Button>
          </Stack>
        </Paper>
      ) : null}
    </>,
  );
}
