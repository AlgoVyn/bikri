import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../sell/Modal.tsx';
import { usePriceCheck } from './priceCheckStore.ts';

/**
 * The card, catalogue search and bundle recipe pull the catalogue/report graph. Keep
 * that out of the shell chunk; a shop that never presses Ctrl+Shift+P never downloads it.
 */
const PriceCheckBody = lazy(() =>
  import('./PriceCheckBody.tsx').then((module) => ({
    default: module.PriceCheckBody,
  })),
);

/** Price check (screens/18): look up a price by scan or name; reads only. */
export function PriceCheck() {
  const open = usePriceCheck((s) => s.open);
  const setOpen = usePriceCheck((s) => s.setOpen);
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      title={t('pricecheck.title')}
      wide
    >
      {open ? (
        <Suspense fallback={null}>
          <PriceCheckBody onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </Modal>
  );
}
