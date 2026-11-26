import { MasterDetail } from '../components/MasterDetail.tsx';
import { QuoteDetail } from './QuoteDetail.tsx';
import { QuotesList } from './QuotesList.tsx';

/** Quotations list + quote detail side by side on desktop (screens/21). */
export function QuotesWorkspace({ quoteId }: { quoteId?: string }) {
  return (
    <MasterDetail
      master={
        <QuotesList
          embedded={quoteId !== undefined}
          detailOpen={quoteId !== undefined}
          selectedId={quoteId}
        />
      }
      detail={quoteId ? <QuoteDetail quoteId={quoteId} /> : undefined}
      showDetail={quoteId !== undefined}
      masterTestId="quotations-master"
      detailTestId="quotations-detail"
    />
  );
}
