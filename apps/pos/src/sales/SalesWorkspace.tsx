import { MasterDetail } from '../components/MasterDetail.tsx';
import { BillDetail } from './BillDetail.tsx';
import { SalesList } from './SalesList.tsx';

/** Sales list + bill detail side by side on desktop (screens/10). */
export function SalesWorkspace({ saleId }: { saleId?: string }) {
  return (
    <MasterDetail
      master={
        <SalesList
          embedded={saleId !== undefined}
          detailOpen={saleId !== undefined}
          selectedId={saleId}
        />
      }
      detail={saleId ? <BillDetail saleId={saleId} embedded /> : undefined}
      showDetail={saleId !== undefined}
      masterTestId="sales-master"
      detailTestId="sales-detail"
    />
  );
}
