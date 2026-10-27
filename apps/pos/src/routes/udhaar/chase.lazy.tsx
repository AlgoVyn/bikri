import { createLazyFileRoute } from '@tanstack/react-router';
import { AreaStrings } from '../../i18n/areas.tsx';
import { ChaseList } from '../../udhaar/ChaseList.tsx';

export const Route = createLazyFileRoute('/udhaar/chase')({
  component: ChaseRoute,
});

function ChaseRoute() {
  return (
    <AreaStrings area="office">
      <ChaseList />
    </AreaStrings>
  );
}
