import { lazy, Suspense, useEffect, useState } from 'react';
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
  const [ready, setReady] = useState(false);

  // Open the dialog only after the lazy body is in memory. Radix focuses the first
  // field on open; if the body arrived afterwards, its input would lose that focus.
  useEffect(() => {
    if (!open) {
      setReady(false);
      return;
    }
    let alive = true;
    void import('./PriceCheckBody.tsx').then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <Modal
      open={open && ready}
      onOpenChange={setOpen}
      title={t('pricecheck.title')}
      wide
    >
      {ready ? (
        <Suspense fallback={null}>
          <PriceCheckBody onClose={() => setOpen(false)} />
        </Suspense>
      ) : null}
    </Modal>
  );
}
