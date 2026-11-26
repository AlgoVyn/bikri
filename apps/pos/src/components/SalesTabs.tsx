import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

/** Bills | Quotations tabs shared by the Sales and Quotations lists (screens/10, 21). */
export function SalesTabs({
  active,
  billCount,
  quotationCount,
  showQuotations = true,
}: {
  active: 'bills' | 'quotations';
  billCount?: number;
  quotationCount?: number;
  showQuotations?: boolean;
}) {
  const { t } = useTranslation();
  const base =
    'inline-flex min-h-9 items-center rounded-[8px] px-4 text-small font-medium transition-colors';
  return (
    <div
      role="tablist"
      aria-label={t('office.quotations.tabs_label')}
      className="inline-flex gap-1 self-start rounded-control bg-surface-2 p-1"
    >
      <Link
        to="/sales"
        role="tab"
        aria-selected={active === 'bills'}
        className={`${base} ${
          active === 'bills'
            ? 'bg-surface text-text shadow-card'
            : 'text-text-muted hover:text-text'
        }`}
      >
        {t('office.quotations.tab_bills')}
        {billCount !== undefined ? ` (${billCount})` : ''}
      </Link>
      {showQuotations ? (
        <Link
          to="/quotations"
          search={{ quote: undefined }}
          role="tab"
          aria-selected={active === 'quotations'}
          className={`${base} ${
            active === 'quotations'
              ? 'bg-surface text-text shadow-card'
              : 'text-text-muted hover:text-text'
          }`}
        >
          {t('office.quotations.tab_quotations')}
          {quotationCount !== undefined ? ` (${quotationCount})` : ''}
        </Link>
      ) : null}
    </div>
  );
}
