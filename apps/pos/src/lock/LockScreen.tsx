/** PIN lock (screens/03, T-035): profile chips, PIN dots and keypad; offline, local only. */
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonQuiet } from '../components/classes.ts';
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
    <main
      className="flex min-h-dvh flex-col bg-bg p-4"
      data-testid="lock-screen"
    >
      <header className="flex items-center justify-between gap-3">
        <div
          className="flex min-w-0 items-center gap-2"
          data-testid="brand-lock"
        >
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-ink"
          >
            <SalesIcon />
          </span>
          <div className="min-w-0">
            <p className="text-small font-semibold uppercase tracking-[0.14em] text-text-muted">
              {t('common.app_name')}
            </p>
            <p className="truncate font-medium">
              {shopName ?? t('common.app_name')}
            </p>
          </div>
        </div>
        <LanguageSelect />
      </header>
      <section className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-5">
        <h1 className="text-h1 font-semibold">{t('lock.who')}</h1>
        <div className="flex flex-wrap justify-center gap-2">
          {data.profiles.map((p) => {
            const until = locks[String(p.id)];
            return (
              <button
                key={String(p.id)}
                type="button"
                aria-pressed={chosen?.id === p.id}
                className={`flex min-h-14 items-center gap-2 rounded-full border px-3 ${chosen?.id === p.id ? 'border-primary bg-primary-subtle' : 'border-border bg-surface'}`}
                onClick={() => {
                  setChosen(p);
                  setPin('');
                  setMessage(null);
                }}
              >
                <span className="flex size-9 items-center justify-center rounded-full bg-primary font-semibold text-primary-ink">
                  {String(p.name).slice(0, 1).toUpperCase()}
                </span>
                <span className="flex flex-col items-start">
                  <span className="font-medium">{String(p.name)}</span>
                  <span className="text-small text-text-muted">
                    {until && until > now
                      ? t('lock.locked_for', { time: mmss(until - now) })
                      : t(`shell.role_${String(p.role)}`)}
                  </span>
                </span>
              </button>
            );
          })}
          {data.support ? (
            <button
              type="button"
              className="flex min-h-14 items-center gap-2 rounded-full border border-border bg-surface px-3"
              onClick={() =>
                unlock({
                  staff_id: SUPPORT_PROFILE_ID,
                  role: 'support',
                  unlocked_at: Date.now(),
                })
              }
            >
              <span className="font-medium">{t('lock.support_profile')}</span>
            </button>
          ) : null}
        </div>
        {chosen ? (
          <>
            <div
              className={`flex gap-3 ${shake ? 'motion-safe:animate-[shake_200ms]' : ''}`}
              aria-label={t('lock.pin_entered', {
                count: pin.length,
                total: length,
              })}
              role="status"
            >
              {DOT_KEYS.slice(0, length).map((k, i) => (
                <span
                  key={k}
                  className={`size-4 rounded-full border-2 border-primary ${i < pin.length ? 'bg-primary' : ''}`}
                />
              ))}
            </div>
            {message ? (
              <p role="alert" className="text-danger">
                {message}
              </p>
            ) : null}
            <div className="grid w-full max-w-72 grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={key}
                  disabled={isLocked || busy}
                  onClick={() => press(d)}
                >
                  {d}
                </button>
              ))}
              <button
                type="button"
                className={`${key} text-body`}
                onClick={() => setPin('')}
              >
                {t('lock.clear')}
              </button>
              <button
                type="button"
                className={key}
                disabled={isLocked || busy}
                onClick={() => press('0')}
              >
                0
              </button>
              <button
                type="button"
                className={key}
                aria-label={t('lock.backspace')}
                onClick={() => setPin((p) => p.slice(0, -1))}
              >
                ⌫
              </button>
            </div>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => setForgot((f) => !f)}
            >
              {t('lock.forgot')}
            </button>
            {forgot ? (
              <p className="text-small text-text-muted">
                {chosen.role === 'owner'
                  ? t('lock.forgot_owner')
                  : t('lock.forgot_staff')}
              </p>
            ) : null}
          </>
        ) : null}
      </section>
      <footer className="text-center text-small text-text-muted">
        <p>{fmt.format(now)}</p>
        <p>{t('lock.kept')}</p>
      </footer>
    </main>
  );
}
