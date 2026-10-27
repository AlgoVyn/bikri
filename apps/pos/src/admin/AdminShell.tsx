import { Link, Outlet } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAreaStrings } from '../i18n/areas.tsx';

const linkClass =
  'inline-flex min-h-11 items-center rounded-control px-3 aria-[current=page]:bg-primary-subtle aria-[current=page]:text-primary-subtle-ink';

export function AdminShell() {
  const { t } = useTranslation();
  const ready = useAreaStrings('admin');
  useEffect(() => {
    if (ready) document.title = t('admin.title');
  }, [t, ready]);
  if (!ready) return <p className="sr-only">{t('common.loading')}</p>;
  return (
    <div className="min-h-screen bg-bg text-text">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2">
          <p className="pe-2 font-semibold">{t('admin.title')}</p>
          <nav className="flex flex-wrap gap-1" aria-label={t('admin.title')}>
            <Link
              to="/admin"
              activeOptions={{ exact: true }}
              className={linkClass}
            >
              {t('admin.nav_overview')}
            </Link>
            <Link to="/admin/tenants" className={linkClass}>
              {t('admin.nav_tenants')}
            </Link>
            <Link to="/admin/backups" className={linkClass}>
              {t('admin.nav_backups')}
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        <Outlet />
      </main>
    </div>
  );
}
