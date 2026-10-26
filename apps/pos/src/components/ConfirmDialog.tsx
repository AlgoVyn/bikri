import * as Dialog from '@radix-ui/react-dialog';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonDanger, buttonQuiet } from './classes.ts';

const overlayClass = 'fixed inset-0 z-40 bg-text/40';
const contentClass =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(28rem,calc(100%-2rem))] flex-col gap-4 rounded-modal bg-surface p-4 text-text shadow-modal';

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleText = title ?? t('ui.confirm_title');
  const bodyText = body ?? t('ui.confirm_body');
  const confirmText = confirmLabel ?? t('ui.confirm_action');
  const cancelText = cancelLabel ?? t('common.cancel');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={contentClass}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRef.current?.focus();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.target === confirmRef.current) {
              return;
            }
            event.preventDefault();
          }}
        >
          <Dialog.Title className="text-title">{titleText}</Dialog.Title>
          <Dialog.Description>{bodyText}</Dialog.Description>
          <div className="flex flex-wrap justify-end gap-2">
            <Dialog.Close asChild>
              <button ref={cancelRef} type="button" className={buttonQuiet}>
                {cancelText}
              </button>
            </Dialog.Close>
            <button
              ref={confirmRef}
              type="button"
              className={buttonDanger}
              onClick={() => {
                onConfirm();
                onOpenChange(false);
              }}
            >
              {confirmText}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
