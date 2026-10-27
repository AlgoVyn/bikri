import type { CartResult } from '@bikri/core';
import type { Cart } from '@bikri/db';
import { useTranslation } from 'react-i18next';
import { MoneyText } from '../components/MoneyText.tsx';
import type { CartId, ShopMoney } from '../data/cart.ts';
import { Modal } from './Modal.tsx';

/** Take payment (screens/06). Filled in by T-017. */
export function PayDialog({
  open,
  onOpenChange,
  totals,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cartId: CartId;
  cart: Cart;
  totals: CartResult;
  money: ShopMoney;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('sell.take_payment')}
    >
      <p className="text-total" data-testid="pay-total">
        <MoneyText paisa={totals.total} />
      </p>
    </Modal>
  );
}
