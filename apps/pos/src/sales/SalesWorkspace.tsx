import { useTranslation } from 'react-i18next';
import { SalesIcon } from '../components/icons.tsx';
import {
  MasterDetail,
  MasterPlaceholder,
} from '../components/MasterDetail.tsx';
import { BillDetail } from './BillDetail.tsx';
import { SalesList } from './SalesList.tsx';

/** Sales list + bill detail side by side on desktop (screens/10). */
export function SalesWorkspace({ saleId }: { saleId?: string }) {
  const { t } = useTranslation();
  return (
    <MasterDetail
      master={<SalesList embedded detailOpen={saleId !== undefined} />}
      detail={saleId ? <BillDetail saleId={saleId} embedded /> : undefined}
      showDetail={saleId !== undefined}
      masterTestId="sales-master"
      detailTestId="sales-detail"
      placeholder={
        <MasterPlaceholder
          icon={<SalesIcon />}
          title={t('office.sales.select_bill')}
          hint={t('office.sales.select_bill_hint')}
        />
      }
    />
  );
}
