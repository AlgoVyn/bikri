import { useTranslation } from 'react-i18next';
import { UdhaarIcon } from '../components/icons.tsx';
import {
  MasterDetail,
  MasterPlaceholder,
} from '../components/MasterDetail.tsx';
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
  const { t } = useTranslation();
  return (
    <MasterDetail
      master={
        <UdhaarList
          initialFilter={initialFilter}
          embedded
          detailOpen={customerId !== undefined}
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
      placeholder={
        <MasterPlaceholder
          icon={<UdhaarIcon />}
          title={t('office.udhaar.select_customer')}
          hint={t('office.udhaar.select_customer_hint')}
        />
      }
    />
  );
}
