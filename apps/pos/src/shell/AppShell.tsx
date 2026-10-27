import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary } from '../components/classes.ts';
import { MoreIcon, SearchIcon } from '../components/icons.tsx';
import { KeyBadge } from '../components/KeyBadge.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { useToast } from '../components/Toast.tsx';
import { ReadOnlyError } from '../data/write.ts';
import { usePrintService } from '../print/usePrintService.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { Banners } from './Banners.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { ignoresHotkey } from './hotkeys.ts';
import { NAV, type NavItem, navItemFor } from './nav.ts';
import { PriceCheck } from './PriceCheck.tsx';
import { usePriceCheck } from './priceCheckStore.ts';
import {
  PrinterDot,
  StaffMenu,
  SyncBadge,
  useShopName,
} from './TopBarParts.tsx';

const navLink =
  'flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-small text-text-muted aria-[current=page]:text-primary lg:flex-none lg:py-1.5';

export function AppShell({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const toast = useToast();
  const { updateReady, applyUpdate } = useUpdateReady();
  usePrintService();
  const { can } = useCurrentStaff();
  const shopName = useShopName();
  const [moreOpen, setMoreOpen] = useState(false);
  const openPriceCheck = usePriceCheck((s) => s.setOpen);

  const allowed = (item: NavItem) => item.perm === null || can(item.perm);
  const visible = NAV.filter(allowed);
  const current = navItemFor(pathname);
  const blocked = current !== undefined && !allowed(current);

  useEffect(() => {
    document.title = t('common.app_title');
  }, [t]);

  // Warm the lazily loaded sale-completion screen as soon as the shell is up, so the first
  // offline sale on a freshly loaded till can still show "Sale complete" (D-114).
  useEffect(() => {
    void import('../sell/SaleComplete.tsx').catch(() => undefined);
  }, []);

  // T-027: a write attempted in a read-only shop shows one toast instead of a generic failure.
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!(event.reason instanceof ReadOnlyError)) return;
      event.preventDefault();
      toast.push(t('tenant.readOnly.blocked'), 'error');
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [t, toast]);

  // screens/04 AC 2: a hidden screen opened by URL goes Home with a toast.
  useEffect(() => {
    if (!blocked) return;
    toast.push(t('shell.no_access'), 'error');
    void navigate({ to: '/', replace: true });
  }, [blocked, navigate, t, toast]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-bound every render so the handler sees the current permissions
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Alt+P works everywhere, even while typing (screens/18).
      if (
        !event.defaultPrevented &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.code === 'KeyP'
      ) {
        event.preventDefault();
        openPriceCheck(true);
        return;
      }
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
          <LanguageSelect />
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
        <button
          type="button"
          className={`${navLink} max-lg:hidden`}
          title={`${t('pricecheck.title')} (Alt+P)`}
          onClick={() => openPriceCheck(true)}
        >
          <SearchIcon />
          <span className="max-w-full truncate">{t('pricecheck.title')}</span>
          <KeyBadge keys="Alt+P" />
        </button>
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
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      setMoreOpen(false);
                      openPriceCheck(true);
                    }}
                    className="flex min-h-11 w-full items-center gap-3 px-3 text-text"
                  >
                    <SearchIcon />
                    {t('pricecheck.title')}
                  </button>
                </li>
              </ul>
            ) : null}
          </div>
        ) : null}
      </nav>
      <main className="pt-topbar pb-tabbar lg:ps-rail lg:pb-0">
        <Banners />
        {blocked ? null : children}
      </main>
      <PriceCheck />
    </div>
  );
}
