import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { ReportsPage } from '../../reports/ReportsPage.tsx';

export const Route = createLazyFileRoute('/reports/')({
  component: ReportsRoute,
});

function ReportsRoute() {
  return (
    <AreaStrings area="office">
      <ReportsPage />
    </AreaStrings>
  );
}
