import { createLazyFileRoute } from '@tanstack/react-router';
import { DayClosePage } from '../../dayclose/DayClosePage.tsx';
import { AreaStrings } from '../../i18n/areas.tsx';

export const Route = createLazyFileRoute('/day-close/')({
  component: DayCloseRoute,
});

function DayCloseRoute() {
  return (
    <AreaStrings area="office">
      <DayClosePage />
    </AreaStrings>
  );
}
