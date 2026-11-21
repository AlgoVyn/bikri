import { useTranslation } from 'react-i18next';
import { buttonQuiet } from './classes.ts';

/**
 * Small page control for the long lists (Customers, Suppliers, Activity, Reports).
 * Lists render one bounded page instead of appending every row as the user scrolls.
 */
export function ListPager({
  page,
  pageCount,
  onPage,
  label,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  label?: string;
}) {
  const { t } = useTranslation();
  if (pageCount <= 1) return null;
  return (
    <nav
      className="flex items-center justify-between gap-2 border-t border-border p-3"
      aria-label={label ?? t('office.sales.pagination')}
    >
      <button
        type="button"
        className={buttonQuiet}
        disabled={page === 0}
        onClick={() => onPage(Math.max(0, page - 1))}
      >
        {t('office.sales.previous')}
      </button>
      <span className="text-small text-text-muted" role="status">
        {t('office.sales.page_of', { page: page + 1, pages: pageCount })}
      </span>
      <button
        type="button"
        className={buttonQuiet}
        disabled={page >= pageCount - 1}
        onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
      >
        {t('office.sales.next')}
      </button>
    </nav>
  );
}
