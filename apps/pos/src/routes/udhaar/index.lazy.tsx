import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { UdhaarWorkspace } from '../../udhaar/UdhaarWorkspace.tsx';

export const Route = createLazyFileRoute('/udhaar/')({
  component: UdhaarRoute,
});

function UdhaarRoute() {
  const { filter } = Route.useSearch();
  return (
    <AreaStrings area="office">
      <UdhaarWorkspace initialFilter={filter ?? 'all'} />
    </AreaStrings>
  );
}
