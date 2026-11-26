import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { QuotesWorkspace } from '../../quotes/QuotesWorkspace.tsx';

export const Route = createLazyFileRoute('/quotations/')({
  component: QuotationsRoute,
});

function QuotationsRoute() {
  const { quote } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <QuotesWorkspace key={quote ?? 'list'} quoteId={quote} />
    </AreaStrings>
  );
}
