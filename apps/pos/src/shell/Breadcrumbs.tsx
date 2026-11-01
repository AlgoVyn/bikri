import { Link, useLocation } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { navItemFor } from './nav.ts';

/** Desktop breadcrumb: Home / parent / current. Phones keep the compact title bar. */
export function Breadcrumbs({ current }: { current: string | null }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const parent = navItemFor(pathname);
  const parentLabel = parent ? t(parent.label) : null;
  const cleanPath = pathname.replace(/\/+$/u, '') || '/';
  const onParent = parent ? cleanPath === parent.to : false;
  const tail =
    current && current !== parentLabel && pathname !== '/' ? current : null;
  return (
    <nav
      aria-label={t('shell.breadcrumb')}
      className="min-w-0 flex-1 truncate max-lg:hidden"
      data-testid="breadcrumbs"
    >
      <ol className="flex min-w-0 items-center gap-1.5 text-small">
        <li className="shrink-0">
          {pathname === '/' ? (
            <span className="font-medium text-text">{t('nav.home')}</span>
          ) : (
            <Link to="/" className="text-text-muted hover:text-text">
              {t('nav.home')}
            </Link>
          )}
        </li>
        {parent && !onParent ? (
          <li className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="text-text-muted">
              ›
            </span>
            <Link
              to={parent.to}
              className="truncate text-text-muted hover:text-text"
            >
              {parentLabel}
            </Link>
          </li>
        ) : null}
        {tail ? (
          <li className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="text-text-muted">
              ›
            </span>
            <span
              aria-current="page"
              className="truncate font-medium text-text"
            >
              {tail}
            </span>
          </li>
        ) : parent && onParent && pathname !== '/' ? (
          <li className="flex min-w-0 items-center gap-1.5">
            <span aria-hidden="true" className="text-text-muted">
              ›
            </span>
            <span
              aria-current="page"
              className="truncate font-medium text-text"
            >
              {parentLabel}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
