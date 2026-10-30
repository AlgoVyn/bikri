import { MasterDetail } from '../components/MasterDetail.tsx';
import type { CustomerFilter } from '../data/udhaar.ts';
import { UdhaarList } from './CustomerList.tsx';
import { CustomerStatement } from './CustomerStatement.tsx';

/** Udhaar customers + khata side by side on desktop (screens/12). */
export function UdhaarWorkspace({
  customerId,
  initialFilter = 'all',
}: {
  customerId?: string;
  initialFilter?: CustomerFilter;
}) {
  return (
    <MasterDetail
      master={
        <UdhaarList
          initialFilter={initialFilter}
          embedded={customerId !== undefined}
          detailOpen={customerId !== undefined}
          selectedId={customerId}
        />
      }
      detail={
        customerId ? (
          <CustomerStatement customerId={customerId} embedded />
        ) : undefined
      }
      showDetail={customerId !== undefined}
      masterTestId="udhaar-master"
      detailTestId="udhaar-detail"
    />
  );
}
