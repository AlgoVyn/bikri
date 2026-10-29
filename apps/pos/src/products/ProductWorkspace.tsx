import { useTranslation } from 'react-i18next';
import { ProductsIcon } from '../components/icons.tsx';
import {
  MasterDetail,
  MasterPlaceholder,
} from '../components/MasterDetail.tsx';
import { ProductDetailPage } from './ProductDetail.tsx';
import { ProductList } from './ProductList.tsx';

/** Products list + detail side by side on desktop (screens/08/09). */
export function ProductWorkspace({
  id,
  adjust = false,
}: {
  id?: string;
  adjust?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <MasterDetail
      master={
        <ProductList embedded detailOpen={id !== undefined} selectedId={id} />
      }
      detail={
        id ? (
          <ProductDetailPage
            key={`${id}:${adjust}`}
            id={id}
            adjust={adjust}
            embedded
          />
        ) : undefined
      }
      showDetail={id !== undefined}
      masterTestId="products-master"
      detailTestId="products-detail"
      placeholder={
        <MasterPlaceholder
          icon={<ProductsIcon />}
          title={t('products.select_product')}
          hint={t('products.select_product_hint')}
        />
      }
    />
  );
}
