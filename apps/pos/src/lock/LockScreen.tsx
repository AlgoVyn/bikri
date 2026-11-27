/** PIN lock (screens/03, T-035): profile chips, PIN dots and keypad; offline, local only. */
import type { MasterRow } from '@bikri/db';
import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import { buttonQuiet } from '../components/classes.ts';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import {
  lockedUntil,
  lockProfiles,
  SUPPORT_PROFILE_ID,
  tryUnlock,
} from '../data/pinLock.ts';
import { useShopTimeZone } from '../data/useShopTimeZone.ts';
import { formatTimestamp } from '../lib/date.ts';
import { Banners } from '../shell/Banners.tsx';
import {
  applyDevicePrefs,
  loadDevicePrefs,
  setKeypadLayout,
} from '../shell/devicePrefs.ts';
import { useShopName } from '../shell/TopBarParts.tsx';
import { prewarmSellCatalogue } from '../state/catalogue.ts';
import { useSession } from '../state/session.ts';
import {
  digitOfKey,
  isPinKeyBlocked,
  keypadDigits,
  ownsKeyTarget,
} from './keypad.ts';

const DOT_KEYS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function LockScreen() {
  const { t, i18n } = useTranslation();
  const timeZone = useShopTimeZone();

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
  // Hide the Sell catalogue's IndexedDB read and chunk load behind PIN entry. The
  // prewarmed rows are only a first render; the live queries still own freshness.
  useEffect(() => {
    void (async () => {
      const shop = await db.shop.get('shop');
      await prewarmSellCatalogue(
        db,
        String(shop?.cost_method) === 'last' ? 'last' : 'avg',
      );
    })().catch(() => undefined);
    void import('../sell/SellPage.tsx');
  }, [db]);
  const unlock = useSession((s) => s.unlock);
  const shopName = useShopName();
  const data = useLiveQuery(
    async () => ({
      profiles: await lockProfiles(db),
      support: (await getKv<string>(db, 'device_kind', 'till')) === 'support',
    }),
    [db],
  );
  const prefs = useLiveQuery(() => loadDevicePrefs(db), [db]);
  const [chosen, setChosen] = useState<MasterRow | null>(null);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [locks, setLocks] = useState<Record<string, number>>({});
  const [forgot, setForgot] = useState(false);
  const countingDown = Object.values(locks).some((until) => until > now);
  // The keypad appends digits outside React state so two fast taps cannot both read
  // the same stale PIN, and a submit in flight cannot be started twice (SYNC-M4).
  const pinRef = useRef('');
  const submittingRef = useRef(false);
  const setPinValue = useCallback((value: string) => {
    pinRef.current = value;
    setPin(value);
  }, []);

  useEffect(() => {
    // A countdown needs one tick per second; an idle lock screen only needs to notice
    // a lockout that another tab/profile set.
    const id = setInterval(
      () => setNow(Date.now()),
      countingDown ? 1000 : 30_000,
    );
    return () => clearInterval(id);
  }, [countingDown]);

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
      // A second submit for the same profile (rapid typing, a double event) must not
      // burn another lockout attempt, and a locked profile never gets here at all.
      if (!chosen || submittingRef.current) return;
      const staffId = String(chosen.id);
      if ((locks[staffId] ?? 0) > Date.now()) {
        setPinValue('');
        return;
      }
      submittingRef.current = true;
      setBusy(true);
      try {
        const res = await tryUnlock(db, staffId, value);
        setPinValue('');
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
          setLocks((l) => ({ ...l, [staffId]: res.until }));
          setMessage(
            t('lock.locked_for', { time: mmss(res.until - Date.now()) }),
          );
        } else setMessage(t('lock.wrong', { count: res.triesLeft }));
      } catch {
        setPinValue('');
        setMessage(t('errors.generic'));
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    },
    [chosen, db, locks, setPinValue, t, unlock],
  );

  const press = useCallback(
    (d: string) => {
      if (!chosen || busy) return;
      if ((locks[String(chosen.id)] ?? 0) > Date.now()) return;
      const length = Number(chosen.pin_length ?? 4) || 4;
      setMessage(null);
      const next = (pinRef.current + d).slice(0, length);
      setPinValue(next);
      if (next.length === length) void submit(next);
    },
    [busy, chosen, locks, setPinValue, submit],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPinKeyBlocked(e) || ownsKeyTarget(e.target)) return;
      const d = digitOfKey(e.key);
      if (d !== null) {
        e.preventDefault();
        press(d);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        setPinValue(pinRef.current.slice(0, -1));
      } else if (e.key === 'Escape') {
        if (pinRef.current) setPinValue('');
        else setChosen(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, setPinValue]);

  if (!data) return null;
  const keypad = prefs?.keypad ?? 'phone';
  const length = chosen ? Number(chosen.pin_length ?? 4) || 4 : 4;
  const chosenLock = chosen ? locks[String(chosen.id)] : undefined;
  const isLocked = chosenLock !== undefined && chosenLock > now;
  const nowText = formatTimestamp(
    now,
    i18n.language,
    timeZone,
    'weekdayLongTime',
  );
  const key =
    'flex h-16 items-center justify-center rounded-card border border-border bg-surface text-h2 font-semibold transition-[background-color,transform] duration-150 hover:bg-surface-2 active:scale-[0.99] active:bg-surface-2';

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
          <BikriMark className="size-9" />
          <div className="min-w-0">
            <p className="text-body font-semibold tracking-wordmark">
              {t('common.app_name')}
            </p>
            <p className="truncate font-medium">
              {shopName ?? t('common.app_name')}
            </p>
          </div>
        </div>
        <LanguageSelect />
      </header>
      <Banners />
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
                className={`flex min-h-14 items-center gap-2 rounded-full border px-3 ${chosen?.id === p.id ? 'border-primary bg-primary-subtle text-primary-subtle-ink' : 'border-border bg-surface'}`}
                onClick={() => {
                  setChosen(p);
                  setPinValue('');
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
            <div
              data-testid="lock-keypad"
              className="grid w-full max-w-72 grid-cols-3 gap-2"
            >
              {keypadDigits(keypad).map((d) => (
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
                onClick={() => setPinValue('')}
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
                onClick={() => setPinValue(pinRef.current.slice(0, -1))}
              >
                ⌫
              </button>
            </div>
            <div className="flex items-center gap-2 text-small text-text-muted">
              <span>{t('lock.keypad')}</span>
              {/* biome-ignore lint/a11y/useSemanticElements: a two-button display toggle, not a form fieldset */}
              <div
                role="group"
                aria-label={t('lock.keypad')}
                className="flex rounded-control border border-border bg-surface p-0.5"
              >
                {(['phone', 'computer'] as const).map((layout) => {
                  const label =
                    layout === 'phone'
                      ? t('lock.keypad_phone')
                      : t('lock.keypad_computer');
                  return (
                    <button
                      key={layout}
                      type="button"
                      aria-pressed={keypad === layout}
                      aria-label={label}
                      title={label}
                      className={`min-h-11 min-w-12 rounded-control px-2 font-mono text-small ${keypad === layout ? 'bg-primary text-primary-ink' : 'text-text-muted hover:bg-surface-2'}`}
                      onClick={() => {
                        void setKeypadLayout(db, layout);
                      }}
                    >
                      {layout === 'phone' ? '123' : '789'}
                    </button>
                  );
                })}
              </div>
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
        <p>{nowText}</p>
        <p>{t('lock.kept')}</p>
      </footer>
    </main>
  );
}
