import { useTranslation } from 'react-i18next';
import { SuppliersIcon } from '../components/icons.tsx';
import {
  MasterDetail,
  MasterPlaceholder,
} from '../components/MasterDetail.tsx';
import { SupplierList } from './SupplierList.tsx';
import { SupplierStatement } from './SupplierStatement.tsx';

/** Suppliers list + ledger side by side on desktop (screens/13). */
export function SupplierWorkspace({ supplierId }: { supplierId?: string }) {
  const { t } = useTranslation();
  return (
    <MasterDetail
      master={<SupplierList embedded detailOpen={supplierId !== undefined} />}
      detail={
        supplierId ? (
          <SupplierStatement supplierId={supplierId} embedded />
        ) : undefined
      }
      showDetail={supplierId !== undefined}
      masterTestId="suppliers-master"
      detailTestId="suppliers-detail"
      placeholder={
        <MasterPlaceholder
          icon={<SuppliersIcon />}
          title={t('office.suppliers.select_supplier')}
          hint={t('office.suppliers.select_supplier_hint')}
        />
      }
    />
  );
}
