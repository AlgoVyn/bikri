import { createLazyFileRoute } from '@tanstack/react-router';
import { ExpensesPage } from '../../expenses/ExpensesPage.tsx';
import { AreaStrings } from '../../i18n/areas.tsx';

export const Route = createLazyFileRoute('/expenses/')({
  component: ExpensesRoute,
});

function ExpensesRoute() {
  return (
    <AreaStrings area="office">
      <ExpensesPage />
    </AreaStrings>
  );
}
