import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { UdhaarWorkspace } from '../../udhaar/UdhaarWorkspace.tsx';

export const Route = createLazyFileRoute('/udhaar/$customerId')({
  component: CustomerRoute,
});

function CustomerRoute() {
  const { customerId } = Route.useParams();
  return (
    <AreaStrings area="office">
      <UdhaarWorkspace customerId={customerId} />
    </AreaStrings>
  );
}
