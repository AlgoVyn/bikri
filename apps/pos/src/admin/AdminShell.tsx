import { Link, Outlet, useLocation } from '@tanstack/react-router';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import {
  ClockIcon,
  CloudIcon,
  ReportsIcon,
  StoreIcon,
  UserIcon,
} from '../components/icons.tsx';
import { LanguageMenu, LanguageSelect } from '../components/LanguageSelect.tsx';
import { useAreaStrings } from '../i18n/areas.tsx';
import { applyStoredTheme } from '../shell/devicePrefs.ts';
import { getSession } from './api.ts';

const NAV = [
  { to: '/admin', label: 'admin.nav_overview', Icon: ReportsIcon },
  { to: '/admin/requests', label: 'admin.nav_requests', Icon: ClockIcon },
  { to: '/admin/tenants', label: 'admin.nav_tenants', Icon: StoreIcon },
  { to: '/admin/backups', label: 'admin.nav_backups', Icon: CloudIcon },
] as const;

const RAIL_COMPACT_KEY = 'bikri.rail_compact';

function readCompactRail(): boolean {
  try {
    return localStorage.getItem(RAIL_COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}

const railLink =
  'relative flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-control px-1 py-2 text-small text-rail-muted transition-colors duration-150 hover:bg-rail-hover hover:text-rail-ink aria-[current=page]:bg-rail-active-bg aria-[current=page]:text-rail-active-ink';

const mobileNavLink =
  'relative flex min-h-11 shrink-0 items-center gap-1.5 rounded-control px-2 text-small text-text-muted hover:bg-surface-2 aria-[current=page]:bg-primary-subtle aria-[current=page]:font-medium aria-[current=page]:text-primary-subtle-ink [&>svg]:size-4';

export function AdminShell() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const ready = useAreaStrings('admin');
  const [email, setEmail] = useState<string | null>(null);
  const [compactRail, setCompactRail] = useState(readCompactRail);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    applyStoredTheme();
  }, []);

  useEffect(() => {
    let live = true;
    void getSession()
      .then((session) => {
        if (live) setEmail(session.email);
      })
      .catch(() => {
        // A signed-out Access screen or an offline console shows no identity chip.
      });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (ready) document.title = t('admin.title');
  }, [t, ready]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = menuRef.current?.contains(document.activeElement) ?? false;
      setMenuOpen(false);
      if (inside) menuTrigger.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape);
    };
  }, [menuOpen]);

  const toggleCompactRail = () => {
    setCompactRail((value) => {
      const next = !value;
      try {
        localStorage.setItem(RAIL_COMPACT_KEY, next ? '1' : '0');
      } catch {
        // Storage can be disabled; the current session still changes width.
      }
      return next;
    });
  };

  if (!ready) return <p className="sr-only">{t('common.loading')}</p>;

  const signedIn = email === null ? null : t('admin.signed_in', { email });
  return (
    <div
      className="min-h-dvh bg-bg text-text"
      data-rail-compact={compactRail ? 'true' : undefined}
      style={
        {
          '--spacing-rail': compactRail ? '64px' : '88px',
        } as CSSProperties
      }
    >
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink"
      >
        {t('admin.skip_content')}
      </a>

      <header className="sticky top-0 z-30 border-b border-border bg-surface shadow-topbar lg:hidden">
        <div className="flex h-topbar items-center gap-2 px-4">
          <Link to="/admin" className="flex min-w-0 items-center gap-2">
            <BikriMark className="size-8" />
            <span className="truncate text-h2 font-semibold tracking-wordmark">
              {t('common.app_name')}
            </span>
            <span className="shrink-0 rounded-full bg-primary-subtle px-2 py-0.5 text-micro font-medium text-primary-subtle-ink">
              {t('admin.operator_short')}
            </span>
          </Link>
          <div className="ms-auto flex items-center gap-2">
            {email === null ? null : (
              <span
                title={signedIn ?? undefined}
                className="hidden min-h-9 max-w-[18rem] items-center gap-1.5 truncate rounded-full bg-surface-2 px-3 text-small text-text-muted sm:inline-flex"
              >
                <UserIcon className="size-4 shrink-0" />
                <bdi dir="ltr" className="truncate">
                  {email}
                </bdi>
              </span>
            )}
            <LanguageSelect />
          </div>
        </div>
        <nav
          aria-label={t('admin.title')}
          className="flex gap-1 overflow-x-auto px-3 pb-2 [mask-image:linear-gradient(to_right,transparent,black_16px,black_calc(100%-16px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0"
        >
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/admin' }}
              className={`${mobileNavLink} shrink-0`}
            >
              <item.Icon />
              <span>{t(item.label)}</span>
            </Link>
          ))}
        </nav>
      </header>

      <aside
        data-testid="admin-rail"
        className="hidden lg:fixed lg:inset-y-0 lg:start-0 lg:z-30 lg:flex lg:w-rail lg:flex-col lg:border-e lg:border-rail-border lg:bg-rail"
      >
        <button
          type="button"
          data-testid="admin-brand-rail"
          title={compactRail ? t('shell.expand_rail') : t('shell.compact_rail')}
          aria-pressed={compactRail}
          onClick={toggleCompactRail}
          className="flex min-h-topbar shrink-0 flex-col items-center justify-center gap-0.5 px-1 py-2 text-rail-ink transition-colors duration-150 hover:bg-rail-hover"
        >
          <BikriMark className="size-8" tone="reversed" />
          <span className="rail-label text-small font-semibold tracking-wordmark text-rail-ink">
            {t('common.app_name')}
          </span>
          <span className="rail-label text-micro font-medium uppercase tracking-[0.12em] text-rail-muted">
            {t('admin.operator_short')}
          </span>
          <span className="sr-only">{t('shell.compact_rail')}</span>
        </button>

        <nav
          aria-label={t('admin.title')}
          className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {NAV.map((item) => {
            const active =
              item.to === '/admin'
                ? pathname.replace(/\/+$/u, '') === '/admin'
                : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/admin' }}
                title={t(item.label)}
                aria-label={t(item.label)}
                className={railLink}
              >
                {active ? (
                  <span
                    aria-hidden="true"
                    className="absolute start-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-full bg-rail-active"
                  />
                ) : null}
                <item.Icon />
                <span className="rail-label max-w-full truncate leading-tight">
                  {t(item.label)}
                </span>
              </Link>
            );
          })}
        </nav>

        <div
          ref={menuRef}
          className="relative shrink-0 border-t border-rail-border p-2"
        >
          <button
            ref={menuTrigger}
            type="button"
            data-testid="admin-operator-menu"
            title={signedIn ?? t('admin.operator_label')}
            aria-label={`${t('admin.operator_short')}. ${signedIn ?? t('admin.operator_label')}`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={() => setMenuOpen((value) => !value)}
            className="flex min-h-14 w-full flex-col items-center justify-center gap-1 rounded-control px-1 py-1 text-small text-rail-muted transition-colors duration-150 hover:bg-rail-hover hover:text-rail-ink aria-expanded:bg-rail-hover aria-expanded:text-rail-ink"
          >
            <span
              aria-hidden="true"
              className="relative flex size-8 items-center justify-center rounded-full bg-primary text-primary-ink"
            >
              <UserIcon className="size-4" />
              <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full border-2 border-rail bg-accent" />
            </span>
            <span className="rail-label max-w-full truncate leading-tight">
              {t('admin.operator_short')}
            </span>
          </button>
          {menuOpen ? (
            <div
              id={menuId}
              data-testid="admin-operator-panel"
              className="absolute bottom-0 start-full z-50 ms-3 max-h-[calc(100dvh-6rem)] w-80 overflow-y-auto rounded-card border border-border bg-surface p-3 text-text shadow-modal"
            >
              <div className="flex items-center gap-2 border-b border-border pb-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink">
                  <UserIcon />
                </span>
                <div className="min-w-0">
                  <p className="text-micro font-medium uppercase tracking-[0.12em] text-text-muted">
                    {t('admin.operator_label')}
                  </p>
                  <p
                    className="truncate font-medium"
                    title={email ?? undefined}
                  >
                    <bdi dir="ltr">{email ?? t('admin.operator_label')}</bdi>
                  </p>
                </div>
              </div>
              <div className="mt-2 border-b border-border py-2">
                <LanguageMenu
                  onPicked={() => {
                    setMenuOpen(false);
                    menuTrigger.current?.focus();
                  }}
                />
              </div>
              <p className="mt-3 flex items-start gap-2 text-small text-text-muted">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent"
                />
                {t('admin.access_note')}
              </p>
            </div>
          ) : null}
        </div>
      </aside>

      <div className="lg:ps-rail">
        <main
          id="admin-main"
          className="mx-auto w-full max-w-[1440px] p-4 lg:p-6 xl:p-8"
        >
          <p className="mb-4 hidden items-center gap-2 text-small text-text-muted lg:flex">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent"
            />
            {t('admin.operator_label')}
          </p>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
