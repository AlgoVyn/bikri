import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { CustomerStatement } from '../../udhaar/CustomerStatement.tsx';

export const Route = createLazyFileRoute('/udhaar/$customerId')({
  component: CustomerRoute,
});

function CustomerRoute() {
  const { customerId } = Route.useParams();
  return (
    <AreaStrings area="office">
      <CustomerStatement customerId={customerId} />
    </AreaStrings>
  );
}
