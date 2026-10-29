import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CloudIcon,
  ReportsIcon,
  SalesIcon,
  StoreIcon,
} from '../components/icons.tsx';
import { LanguageSelect } from '../components/LanguageSelect.tsx';
import { useAreaStrings } from '../i18n/areas.tsx';

const NAV = [
  { to: '/admin', label: 'admin.nav_overview', Icon: ReportsIcon },
  { to: '/admin/tenants', label: 'admin.nav_tenants', Icon: StoreIcon },
  { to: '/admin/backups', label: 'admin.nav_backups', Icon: CloudIcon },
] as const;

const navLink =
  'relative flex min-h-11 items-center gap-3 rounded-control px-3 text-small text-text-muted hover:bg-surface-2 aria-[current=page]:bg-primary-subtle aria-[current=page]:font-medium aria-[current=page]:text-primary-subtle-ink lg:text-rail-muted lg:hover:bg-white/5 lg:hover:text-rail-ink lg:aria-[current=page]:bg-white/10 lg:aria-[current=page]:text-white';

export function AdminShell() {
  const { t } = useTranslation();
  const ready = useAreaStrings('admin');
  useEffect(() => {
    if (ready) document.title = t('admin.title');
  }, [t, ready]);
  if (!ready) return <p className="sr-only">{t('common.loading')}</p>;
  return (
    <div className="min-h-dvh bg-bg text-text">
      <a
        href="#admin-main"
        className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-ink"
      >
        {t('admin.skip_content')}
      </a>
      <div className="lg:grid lg:min-h-dvh lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="hidden border-e border-white/10 bg-rail lg:flex lg:flex-col">
          <Link
            to="/admin"
            className="flex h-topbar shrink-0 items-center gap-2.5 border-b border-white/10 px-4"
          >
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-accent text-accent-ink"
            >
              <SalesIcon />
            </span>
            <span className="min-w-0">
              <span className="block text-[11px] font-semibold uppercase tracking-[0.18em] text-rail-ink">
                {t('common.app_name')}
              </span>
              <span className="block truncate text-[11px] text-rail-muted">
                {t('admin.title')}
              </span>
            </span>
          </Link>
          <nav
            aria-label={t('admin.title')}
            className="flex flex-1 flex-col gap-1 p-3"
          >
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.to === '/admin' }}
                className={navLink}
              >
                <item.Icon />
                <span>{t(item.label)}</span>
              </Link>
            ))}
          </nav>
          <p className="flex items-center gap-2 border-t border-white/10 px-4 py-3 text-[11px] text-rail-muted">
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent"
            />
            {t('admin.access_note')}
          </p>
        </aside>
        <div className="flex min-w-0 flex-col">
          <header className="sticky top-0 z-30 border-b border-border bg-surface shadow-topbar">
            <div className="flex h-topbar items-center gap-2 px-4">
              <Link to="/admin" className="flex items-center gap-2 lg:hidden">
                <span
                  aria-hidden="true"
                  className="flex size-8 items-center justify-center rounded-[10px] bg-accent text-accent-ink"
                >
                  <SalesIcon />
                </span>
                <span className="text-small font-semibold uppercase tracking-[0.16em]">
                  {t('common.app_name')}
                </span>
              </Link>
              <span className="hidden text-small text-text-muted lg:block">
                {t('admin.operator_label')}
              </span>
              <div className="ms-auto flex items-center gap-2">
                <LanguageSelect />
              </div>
            </div>
            <nav
              aria-label={t('admin.title')}
              className="flex gap-1 overflow-x-auto px-3 pb-2 lg:hidden"
            >
              {NAV.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeOptions={{ exact: item.to === '/admin' }}
                  className={`${navLink} shrink-0`}
                >
                  <item.Icon />
                  <span>{t(item.label)}</span>
                </Link>
              ))}
            </nav>
          </header>
          <main
            id="admin-main"
            className="mx-auto w-full max-w-[1280px] flex-1 p-4 lg:p-6"
          >
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
