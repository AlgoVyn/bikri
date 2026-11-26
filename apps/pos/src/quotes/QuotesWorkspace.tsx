import { useTranslation } from 'react-i18next';
import { MasterDetail } from '../components/MasterDetail.tsx';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { QuoteDetail } from './QuoteDetail.tsx';
import { QuotesList } from './QuotesList.tsx';

/** Quotations list + quote detail side by side on desktop (screens/21). */
export function QuotesWorkspace({ quoteId }: { quoteId?: string }) {
  const { t } = useTranslation();
  const { can } = useCurrentStaff();
  if (!can('sale.create'))
    return (
      <p className="p-4 text-text-muted">{t('office.quotations.forbidden')}</p>
    );
  return (
    <MasterDetail
      master={
        <QuotesList
          embedded={quoteId !== undefined}
          detailOpen={quoteId !== undefined}
          selectedId={quoteId}
        />
      }
      detail={
        quoteId ? <QuoteDetail key={quoteId} quoteId={quoteId} /> : undefined
      }
      showDetail={quoteId !== undefined}
      masterTestId="quotations-master"
      detailTestId="quotations-detail"
    />
  );
}
