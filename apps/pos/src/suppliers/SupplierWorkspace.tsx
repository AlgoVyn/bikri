import { MasterDetail } from '../components/MasterDetail.tsx';
import { SupplierList } from './SupplierList.tsx';
import { SupplierStatement } from './SupplierStatement.tsx';

/** Suppliers list + ledger side by side on desktop (screens/13). */
export function SupplierWorkspace({ supplierId }: { supplierId?: string }) {
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
          <SupplierStatement supplierId={supplierId} embedded />
        ) : undefined
      }
      showDetail={supplierId !== undefined}
      masterTestId="suppliers-master"
      detailTestId="suppliers-detail"
    />
  );
}
