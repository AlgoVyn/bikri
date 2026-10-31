/** PIN lock (screens/03, T-035): profile chips, PIN dots and keypad; offline, local only. */
import type { MasterRow } from '@bikri/db';
import {
  Avatar,
  Box,
  Button,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SalesIcon } from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import {
  lockedUntil,
  lockProfiles,
  SUPPORT_PROFILE_ID,
  tryUnlock,
} from '../data/pinLock.ts';
import { Banners } from '../shell/Banners.tsx';
import { applyDevicePrefs, loadDevicePrefs } from '../shell/devicePrefs.ts';
import { useShopName } from '../shell/TopBarParts.tsx';
import { useSession } from '../state/session.ts';

const DOT_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];
const URDU = '۰۱۲۳۴۵۶۷۸۹';

function digitOf(key: string): string | null {
  if (key >= '0' && key <= '9' && key.length === 1) return key;
  const u = URDU.indexOf(key);
  return u >= 0 ? String(u) : null;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function LockScreen() {
  const { t, i18n } = useTranslation();

  // The lock screen sits outside AppShell, so apply the device's chosen theme here too.
  useEffect(() => {
    let alive = true;
    void loadDevicePrefs(getDb()).then((prefs) => {
      if (alive) applyDevicePrefs(prefs, i18n.language);
    });
    return () => {
      alive = false;
    };
  }, [i18n.language]);
  const db = getDb();
  const unlock = useSession((s) => s.unlock);
  const shopName = useShopName();
  const data = useLiveQuery(
    async () => ({
      profiles: await lockProfiles(db),
      support: (await getKv<string>(db, 'device_kind', 'till')) === 'support',
    }),
    [db],
  );
  const [chosen, setChosen] = useState<MasterRow | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [locks, setLocks] = useState<Record<string, number>>({});
  const [forgot, setForgot] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!data) return;
    void (async () => {
      const out: Record<string, number> = {};
      for (const p of data.profiles) {
        const until = await lockedUntil(db, String(p.id));
        if (until) out[String(p.id)] = until;
      }
      setLocks(out);
    })();
    if (!chosen && data.profiles.length === 1 && !data.support)
      setChosen(data.profiles[0] ?? null);
  }, [data, db, chosen]);

  const submit = useCallback(
    async (value: string) => {
      if (!chosen) return;
      setBusy(true);
      const res = await tryUnlock(db, String(chosen.id), value);
      setBusy(false);
      setPin('');
      if (res.kind === 'ok') {
        unlock({
          staff_id: String(res.staff.id),
          role: res.staff.role as 'owner' | 'manager' | 'cashier',
          unlocked_at: Date.now(),
        });
        return;
      }
      setShake(true);
      setTimeout(() => setShake(false), 200);
      if (res.kind === 'locked') {
        setLocks((l) => ({ ...l, [String(chosen.id)]: res.until }));
        setMessage(
          t('lock.locked_for', { time: mmss(res.until - Date.now()) }),
        );
      } else setMessage(t('lock.wrong', { count: res.triesLeft }));
    },
    [chosen, db, t, unlock],
  );

  const press = useCallback(
    (d: string) => {
      if (!chosen || busy) return;
      const length = Number(chosen.pin_length ?? 4) || 4;
      setMessage(null);
      setPin((p) => {
        const next = (p + d).slice(0, length);
        if (next.length === length) void submit(next);
        return next;
      });
    },
    [busy, chosen, submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = digitOf(e.key);
      if (d !== null) {
        e.preventDefault();
        press(d);
      } else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Escape') {
        if (pin) setPin('');
        else setChosen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, pin]);

  if (!data) return null;
  const length = chosen ? Number(chosen.pin_length ?? 4) || 4 : 4;
  const chosenLock = chosen ? locks[String(chosen.id)] : undefined;
  const isLocked = chosenLock !== undefined && chosenLock > now;
  const fmt = new Intl.DateTimeFormat(
    i18n.language === 'ur' ? 'ur-PK' : 'en-PK',
    {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Asia/Karachi',
    },
  );
  const key =
    'flex h-16 items-center justify-center rounded-card border border-border bg-surface text-h2 font-semibold';

  return (
    <Box
      component="main"
      mih="100dvh"
      bg="var(--mantine-color-body)"
      p="md"
      style={{ display: 'flex', flexDirection: 'column' }}
      data-testid="lock-screen"
    >
      <Group justify="space-between" align="center" gap="sm">
        <Group gap="sm" wrap="nowrap" data-testid="brand-lock">
          <ThemeIcon size={38} radius="md" color="accent" variant="filled">
            <SalesIcon />
          </ThemeIcon>
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">
              {t('common.app_name')}
            </Text>
            <Text size="sm" fw={600} truncate>
              {shopName ?? t('common.app_name')}
            </Text>
          </Stack>
        </Group>
        <LanguageSelect />
      </Group>
      <Banners />
      <Stack
        gap="lg"
        align="center"
        justify="center"
        style={{ flex: 1 }}
        maw={420}
        mx="auto"
        w="100%"
      >
        <Title order={1}>{t('lock.who')}</Title>
        <Group justify="center" gap="sm">
          {data.profiles.map((p) => {
            const until = locks[String(p.id)];
            return (
              <UnstyledButton
                key={String(p.id)}
                aria-pressed={chosen?.id === p.id}
                onClick={() => {
                  setChosen(p);
                  setPin('');
                  setMessage(null);
                }}
              >
                <Paper
                  withBorder
                  p="xs"
                  pr="md"
                  radius="xl"
                  style={{
                    borderColor:
                      chosen?.id === p.id
                        ? 'var(--mantine-color-brand-6)'
                        : undefined,
                    background:
                      chosen?.id === p.id
                        ? 'var(--mantine-color-brand-0)'
                        : undefined,
                  }}
                >
                  <Group gap="sm" wrap="nowrap">
                    <Avatar color="brand" radius="xl">
                      {String(p.name).slice(0, 1).toUpperCase()}
                    </Avatar>
                    <Stack gap={0}>
                      <Text size="sm" fw={600}>
                        {String(p.name)}
                      </Text>
                      <Text size="xs" c="dimmed">
                        {until && until > now
                          ? t('lock.locked_for', { time: mmss(until - now) })
                          : t(`shell.role_${String(p.role)}`)}
                      </Text>
                    </Stack>
                  </Group>
                </Paper>
              </UnstyledButton>
            );
          })}
          {data.support ? (
            <Button
              variant="default"
              radius="xl"
              onClick={() =>
                unlock({
                  staff_id: SUPPORT_PROFILE_ID,
                  role: 'support',
                  unlocked_at: Date.now(),
                })
              }
            >
              {t('lock.support_profile')}
            </Button>
          ) : null}
        </Group>
        {chosen ? (
          <>
            <Group
              gap="sm"
              aria-label={t('lock.pin_entered', {
                count: pin.length,
                total: length,
              })}
              role="status"
              className={
                shake ? 'motion-safe:animate-[shake_200ms]' : undefined
              }
            >
              {DOT_KEYS.slice(0, length).map((k, i) => (
                <Box
                  key={k}
                  w={16}
                  h={16}
                  style={{
                    borderRadius: 999,
                    border: '2px solid var(--mantine-color-brand-6)',
                    background:
                      i < pin.length
                        ? 'var(--mantine-color-brand-6)'
                        : 'transparent',
                  }}
                />
              ))}
            </Group>
            {message ? (
              <Text role="alert" c="red" size="sm">
                {message}
              </Text>
            ) : null}
            <SimpleGrid cols={3} spacing="sm" w="100%" maw={300}>
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <Button
                  key={d}
                  variant="default"
                  size="xl"
                  h={64}
                  fz="1.2rem"
                  disabled={isLocked || busy}
                  onClick={() => press(d)}
                >
                  {d}
                </Button>
              ))}
              <Button
                variant="default"
                size="xl"
                h={64}
                onClick={() => setPin('')}
              >
                {t('lock.clear')}
              </Button>
              <Button
                variant="default"
                size="xl"
                h={64}
                disabled={isLocked || busy}
                onClick={() => press('0')}
              >
                0
              </Button>
              <Button
                variant="default"
                size="xl"
                h={64}
                aria-label={t('lock.backspace')}
                onClick={() => setPin((p) => p.slice(0, -1))}
              >
                ⌫
              </Button>
            </SimpleGrid>
            <Button variant="subtle" onClick={() => setForgot((f) => !f)}>
              {t('lock.forgot')}
            </Button>
            {forgot ? (
              <Text size="sm" c="dimmed" ta="center">
                {chosen.role === 'owner'
                  ? t('lock.forgot_owner')
                  : t('lock.forgot_staff')}
              </Text>
            ) : null}
          </>
        ) : null}
      </Stack>
      <Stack gap={2} align="center">
        <Text size="sm" c="dimmed">
          {fmt.format(now)}
        </Text>
        <Text size="sm" c="dimmed">
          {t('lock.kept')}
        </Text>
      </Stack>
    </Box>
  );
}
