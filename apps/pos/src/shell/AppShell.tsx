import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BikriMark } from '../components/BikriMark.tsx';
import { buttonPrimary } from '../components/classes.ts';
import { MoreIcon, RefreshIcon } from '../components/icons.tsx';
import { PrivacyProvider } from '../components/privacy.tsx';
import { useToast } from '../components/Toast.tsx';
import { getDb } from '../data/db.ts';
import { ReadOnlyError } from '../data/write.ts';
import { usePrintService } from '../print/usePrintService.ts';
import { useUpdateReady } from '../pwa/useUpdateReady.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { Banners } from './Banners.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import {
  applyDevicePrefs,
  loadDevicePrefs,
  togglePrivacyMode,
} from './devicePrefs.ts';
import { GlobalSearchHost, GlobalSearchTrigger } from './GlobalSearch.tsx';
import { dialogOpen, ignoresHotkey } from './hotkeys.ts';
import { NAV, type NavItem, navItemFor } from './nav.ts';
import { PriceCheck } from './PriceCheck.tsx';
import { usePriceCheck } from './priceCheckStore.ts';
import { StaffMenu, useShopName } from './TopBarParts.tsx';
import { useIsDesktop } from './useIsDesktop.ts';

/** `/sell` and its completion/dialog state: the cashier needs every price, always. */
function isSellingRoute(pathname: string): boolean {
  const path = pathname.replace(/\/+$/u, '');
  return path === '/sell' || path.startsWith('/sell/');
}

const navLink =
  'relative flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-small transition-colors duration-150 lg:flex-none lg:py-2';

const RAIL_COMPACT_KEY = 'bikri.rail_compact';

function readCompactRail(): boolean {
  try {
    return localStorage.getItem(RAIL_COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}

/** Shell pages that are not rail items still need a title on a phone. */
const EXTRA_TITLES: Record<string, string> = {
  '/day-close': 'home.day_close',
  // The page has its own "Stock count" header; the bar shows the parent section.
  '/stock/count': 'nav.products',
  '/labels': 'products.print_label',
};

export function AppShell({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const selling = isSellingRoute(pathname);
  const toast = useToast();
  const { updateReady, applyUpdate } = useUpdateReady();
  usePrintService();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const shopName = useShopName();
  const desktop = useIsDesktop();
  const [compactRail, setCompactRail] = useState(readCompactRail);
  const [moreOpen, setMoreOpen] = useState(false);
  const [updating, setUpdating] = useState(false);
  const openPriceCheck = usePriceCheck((s) => s.setOpen);
  const privacyEnabled = useLiveQuery(
    async () => (await loadDevicePrefs(getDb())).privacyMode,
    [],
  );
  // Mask until the stored preference is known, so a reload can never flash a real amount.
  const privacyActive = (privacyEnabled ?? true) && !selling;
  const togglePrivacy = () => {
    void togglePrivacyMode(getDb())
      .then((next) => {
        const selling = isSellingRoute(pathname);
        toast.push(
          t(
            next
              ? selling
                ? 'privacy.hidden_toast_selling'
                : 'privacy.hidden_toast'
              : 'privacy.visible_toast',
          ),
        );
      })
      .catch(() => toast.push(t('errors.generic'), 'error'));
  };

  const allowed = (item: NavItem) =>
    item.to !== '/sell' || !readOnly
      ? item.permAny !== undefined
        ? item.permAny.some((permission) => can(permission))
        : item.perm === null || can(item.perm)
      : false;
  const visible = NAV.filter(allowed);
  const startUpdate = () => {
    setUpdating(true);
    applyUpdate();
    // If the browser never fires the controller change, let the button retry
    // instead of leaving it disabled forever.
    window.setTimeout(() => setUpdating(false), 10_000);
  };
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
  const current = navItemFor(pathname);
  const extraTitle = EXTRA_TITLES[pathname.replace(/\/+$/u, '')];
  const screenTitle = current
    ? t(current.label)
    : extraTitle
      ? t(extraTitle)
      : null;
  const blocked = current !== undefined && !allowed(current);

  useEffect(() => {
    document.title = t('common.app_title');
  }, [t]);

  // Device-level display preferences (screens/17).
  useEffect(() => {
    let alive = true;
    void loadDevicePrefs(getDb())
      .then((prefs) => {
        if (alive) applyDevicePrefs(prefs, i18n.language);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [i18n.language]);

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

  // Re-bound every render so the handler sees the current permissions.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Hide amounts is a display action: it must also work in a field or an open dialog.
      if (
        !event.defaultPrevented &&
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.code === 'KeyH'
      ) {
        event.preventDefault();
        togglePrivacy();
        return;
      }
      // Ctrl+Shift+P works everywhere, even while typing (screens/18).
      if (
        !event.defaultPrevented &&
        !dialogOpen() &&
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.code === 'KeyP'
      ) {
        event.preventDefault();
        openPriceCheck(true);
        return;
      }
      if (
        event.defaultPrevented ||
        event.metaKey ||
        ignoresHotkey(event.target) ||
        dialogOpen()
      )
        return;
      if (
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        (event.key === 'n' || event.key === 'N')
      ) {
        if (readOnly || !can('sale.create')) return;
        event.preventDefault();
        void navigate({ to: '/sell' });
        return;
      }
      if (!event.ctrlKey || !event.shiftKey || event.altKey) return;
      const digit = /^Digit([1-9])$/u.exec(event.code)?.[1];
      const item = digit === undefined ? undefined : NAV[Number(digit) - 1];
      if (item === undefined || !allowed(item)) return;
      event.preventDefault();
      void navigate({ to: item.to });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const navItems = visible.filter((item) => !item.hideInNav);
  const more = navItems.filter((item) => !item.bar);
  const moreActive = more.some((item) => item.to === current?.to);

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
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink"
      >
        {t('shell.skip_content')}
      </a>
      {!desktop ? (
        <header className="fixed start-0 end-0 top-0 z-30 flex h-topbar items-center gap-2 border-b border-border bg-surface px-3 shadow-topbar">
          <span
            className="min-w-0 flex-1 truncate font-semibold"
            data-testid="screen-title-bar"
          >
            {screenTitle ?? shopName ?? t('common.app_name')}
          </span>
          <div className="flex shrink-0 items-center gap-1">
            <GlobalSearchTrigger variant="topbar" />
            {updateReady ? (
              <button
                type="button"
                className={buttonPrimary}
                disabled={updating}
                aria-busy={updating}
                onClick={startUpdate}
              >
                {updating ? t('shell.updating') : t('shell.update_ready')}
              </button>
            ) : null}
            <StaffMenu shopName={shopName} variant="topbar" />
          </div>
        </header>
      ) : null}
      <nav
        aria-label={t('nav.rail')}
        className="fixed z-30 flex border-border bg-surface max-lg:inset-x-0 max-lg:bottom-0 max-lg:h-tabbar max-lg:items-stretch max-lg:justify-around max-lg:border-t max-lg:shadow-tabbar lg:inset-y-0 lg:start-0 lg:w-rail lg:flex-col lg:border-e lg:border-rail-border lg:bg-rail"
      >
        <button
          type="button"
          className="hidden min-h-topbar w-full shrink-0 flex-col items-center justify-center gap-0.5 px-1 py-2 text-rail-ink transition-colors duration-150 hover:bg-rail-hover lg:flex"
          data-testid="brand-rail"
          title={compactRail ? t('shell.expand_rail') : t('shell.compact_rail')}
          aria-label={`${t('common.app_name')} — ${t('shell.compact_rail')}`}
          aria-pressed={compactRail}
          onClick={toggleCompactRail}
        >
          <BikriMark className="size-8" tone="reversed" />
          <span className="rail-label text-small font-semibold tracking-wordmark text-rail-ink">
            {t('common.app_name')}
          </span>
        </button>
        <div
          className="contents lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:[scrollbar-width:none] lg:[&::-webkit-scrollbar]:hidden"
          data-testid="rail-scroll"
        >
          {navItems.map((item) => {
            const active = current?.to === item.to;
            return (
              <Link
                key={item.to}
                to={item.to}
                title={`${t(item.label)} (${item.keys})`}
                aria-label={`${t(item.label)} (${item.keys})`}
                activeOptions={{ exact: item.to === '/' }}
                className={`${navLink} ${item.bar ? '' : 'max-lg:hidden'} ${
                  active
                    ? 'text-primary lg:bg-rail-active-bg lg:text-rail-active-ink'
                    : 'text-text-muted lg:text-rail-muted lg:hover:bg-rail-hover lg:hover:text-rail-ink'
                }`}
              >
                {active ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="absolute start-0 top-1/2 hidden h-6 w-1 -translate-y-1/2 rounded-full bg-rail-active lg:block"
                    />
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary lg:hidden"
                    />
                  </>
                ) : null}
                <item.Icon />
                <span className="rail-label max-w-full truncate leading-tight">
                  {t(item.label)}
                </span>
              </Link>
            );
          })}
        </div>
        {more.length > 0 ? (
          <div className="relative flex min-w-0 flex-1 lg:hidden">
            <button
              type="button"
              className={`${navLink} ${
                moreActive ? 'text-primary' : 'text-text-muted'
              }`}
              aria-expanded={moreOpen}
              aria-controls="more-menu"
              onClick={() => setMoreOpen((open) => !open)}
            >
              {moreActive ? (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary"
                />
              ) : null}
              <MoreIcon />
              <span className="max-w-full truncate">{t('nav.more')}</span>
            </button>
            {moreOpen ? (
              <ul
                id="more-menu"
                className="absolute end-1 bottom-full mb-2 w-48 rounded-card border border-border bg-surface py-1 shadow-modal"
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
        {desktop ? (
          <div className="hidden w-full shrink-0 flex-col border-t border-rail-border lg:flex">
            <GlobalSearchTrigger variant="rail" />
            {updateReady ? (
              <button
                type="button"
                disabled={updating}
                aria-busy={updating}
                title={t('shell.update_ready')}
                aria-label={
                  updating ? t('shell.updating') : t('shell.update_ready')
                }
                onClick={startUpdate}
                className={`${navLink} text-rail-active hover:bg-rail-hover`}
              >
                <RefreshIcon />
                <span className="rail-label max-w-full truncate leading-tight">
                  {updating ? t('shell.updating') : t('shell.update_ready')}
                </span>
              </button>
            ) : null}
            <div className="mt-1 border-t border-rail-border pt-2">
              <StaffMenu shopName={shopName} variant="rail" />
            </div>
          </div>
        ) : null}
      </nav>
      <main
        id="main-content"
        className={`${
          selling ? 'h-dvh pt-0 pb-0' : 'pt-topbar pb-tabbar'
        } lg:ps-rail lg:pt-0 lg:pb-0`}
      >
        <PrivacyProvider active={privacyActive}>
          <Banners />
          {blocked ? null : children}
        </PrivacyProvider>
      </main>
      <PrivacyProvider active={false}>
        <PriceCheck />
      </PrivacyProvider>
      <GlobalSearchHost />
      <CommandPalette />
    </div>
  );
}
