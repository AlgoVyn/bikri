import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import { MoreIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { useToast } from '../components/Toast.tsx';
import { isLocale, setLanguage } from '../i18n/i18n.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { Banners } from './Banners.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { ignoresHotkey } from './hotkeys.ts';
import { NAV, type NavItem, navItemFor } from './nav.ts';
import {
  PrinterDot,
  StaffMenu,
  SyncBadge,
  useShopName,
} from './TopBarParts.tsx';

const navLink =
  'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-small text-text-muted aria-[current=page]:text-primary lg:flex-none lg:py-1.5';

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const { updateReady, applyUpdate } = useUpdateReady();
  const { can } = useCurrentStaff();
  const shopName = useShopName();
  const language = isLocale(i18n.language) ? i18n.language : 'en';
  const [moreOpen, setMoreOpen] = useState(false);

  const allowed = (item: NavItem) => item.perm === null || can(item.perm);
  const visible = NAV.filter(allowed);
  const current = navItemFor(pathname);
  const blocked = current !== undefined && !allowed(current);

  useEffect(() => {
    document.title = t('common.app_title');
  }, [t]);

  // screens/04 AC 2: a hidden screen opened by URL goes Home with a toast.
  useEffect(() => {
    if (!blocked) return;
    toast.push(t('shell.no_access'), 'error');
    void navigate({ to: '/', replace: true });
  }, [blocked, navigate, t, toast]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bound every render so the handler sees the current permissions
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        ignoresHotkey(event.target)
      )
        return;
      if (
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'n' || event.key === 'N')
      ) {
        if (!can('sale.create')) return;
        event.preventDefault();
        void navigate({ to: '/sell' });
        return;
      }
      if (!event.altKey || event.shiftKey) return;
      const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
      const item = digit === undefined ? undefined : NAV[Number(digit) - 1];
      if (item === undefined || !allowed(item)) return;
      event.preventDefault();
      void navigate({ to: item.to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const more = visible.filter((item) => !item.bar);

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="fixed start-0 end-0 top-0 z-30 flex h-topbar items-center gap-2 border-b border-border bg-surface px-3 lg:start-rail">
        <span
          className="min-w-0 flex-1 truncate font-medium lg:hidden"
          data-testid="shop-name-bar"
        >
          {shopName ?? t('common.app_name')}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium max-lg:hidden">
          {current ? t(current.label) : ''}
        </span>
        <div className="flex shrink-0 items-center gap-1 lg:gap-2">
          <GlobalSearch />
          {updateReady ? (
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => applyUpdate()}
            >
              {t('shell.update_ready')}
            </button>
          ) : null}
          <SyncBadge />
          <PrinterDot />
          {import.meta.env.DEV ? (
            <Link
              to="/dev/ui"
              className="text-small text-primary max-lg:hidden"
            >
              {t('shell.ui_kit')}
            </Link>
          ) : null}
          <label className="inline-flex items-center">
            <span className="sr-only">{t('shell.language')}</span>
            <select
              className="h-11 max-w-24 rounded-control border border-border-strong bg-surface px-1 text-text"
              value={language}
              onChange={(event) => {
                const next = event.target.value;
                if (isLocale(next)) void setLanguage(next);
              }}
            >
              <option value="en">{t('shell.lang_en')}</option>
              <option value="ur">{t('shell.lang_ur')}</option>
              <option value="roman-ur">{t('shell.lang_roman_ur')}</option>
            </select>
          </label>
          <StaffMenu />
        </div>
      </header>
      <nav
        aria-label={t('nav.rail')}
        className="fixed z-30 flex border-border bg-surface max-lg:inset-x-0 max-lg:bottom-0 max-lg:h-tabbar max-lg:items-stretch max-lg:justify-around max-lg:border-t lg:inset-y-0 lg:start-0 lg:w-rail lg:flex-col lg:overflow-y-auto lg:border-e"
      >
        <span
          className="hidden h-topbar shrink-0 items-center justify-center break-words px-1 text-center text-small font-semibold leading-tight lg:flex"
          data-testid="shop-name-rail"
        >
          {shopName ?? t('common.app_name')}
        </span>
        {visible.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            title={`${t(item.label)} (${item.keys})`}
            activeOptions={{ exact: item.to === '/' }}
            className={`${navLink} ${item.bar ? '' : 'max-lg:hidden'}`}
          >
            <item.Icon />
            <span className="max-w-full truncate">{t(item.label)}</span>
            <span className="max-lg:hidden">
              <KeyBadge keys={item.keys} />
            </span>
          </Link>
        ))}
        {more.length > 0 ? (
          <div className="relative flex min-w-0 flex-1 lg:hidden">
            <button
              type="button"
              className={navLink}
              aria-expanded={moreOpen}
              aria-controls="more-menu"
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreIcon />
              <span className="max-w-full truncate">{t('nav.more')}</span>
            </button>
            {moreOpen ? (
              <ul
                id="more-menu"
                className="absolute end-1 bottom-full mb-2 w-48 rounded-card border border-border bg-surface py-1 shadow-lg"
              >
                {more.map((item) => (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      onClick={() => setMoreOpen(false)}
                      className="flex min-h-11 items-center gap-3 px-3 text-text aria-[current=page]:text-primary"
                    >
                      <item.Icon />
                      {t(item.label)}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </nav>
      <main className="pt-topbar pb-tabbar lg:ps-rail lg:pb-0">
        <Banners />
        {blocked ? null : children}
      </main>
    </div>
  );
}
