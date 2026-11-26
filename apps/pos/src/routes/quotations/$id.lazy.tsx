import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { QuotesWorkspace } from '../../quotes/QuotesWorkspace.tsx';

export const Route = createLazyFileRoute('/quotations/$id')({
  component: QuoteRoute,
});

function QuoteRoute() {
  const { id } = Route.useParams();
  return (
    <AreaStrings area="office">
      <QuotesWorkspace quoteId={id} />
    </AreaStrings>
  );
}
