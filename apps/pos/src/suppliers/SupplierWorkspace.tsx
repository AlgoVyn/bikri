import { MasterDetail } from '../components/MasterDetail.tsx';
import { SupplierList } from './SupplierList.tsx';
import { SupplierStatement } from './SupplierStatement.tsx';

/** Suppliers list + ledger side by side on desktop (screens/13). */
export function SupplierWorkspace({
  supplierId,
  delivery,
}: {
  supplierId?: string;
  /** Delivery details to open from a stock-history link (`?delivery=<purchaseId>`). */
  delivery?: string;
}) {
  return (
    <MasterDetail
      master={
        <SupplierList
          embedded={supplierId !== undefined}
          detailOpen={supplierId !== undefined}
          selectedId={supplierId}
        />
      }
      detail={
        supplierId ? (
          <SupplierStatement
            supplierId={supplierId}
            embedded
            initialDeliveryId={delivery}
          />
        ) : undefined
      }
      showDetail={supplierId !== undefined}
      masterTestId="suppliers-master"
      detailTestId="suppliers-detail"
    />
  );
}
