import { Button, Group } from '@mantine/core';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '../sell/Modal.tsx';

/** A destructive confirmation on the shared Mantine modal. Cancel gets initial focus. */
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
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleText = title ?? t('ui.confirm_title');
  const bodyText = body ?? t('ui.confirm_body');
  const confirmText = confirmLabel ?? t('ui.confirm_action');
  const cancelText = cancelLabel ?? t('common.cancel');

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={titleText}>
      <div>
        <p className="m-0 text-text">{bodyText}</p>
        <Group justify="flex-end" gap="sm" mt="lg">
          <Button
            variant="default"
            autoFocus
            data-autofocus
            onClick={() => onOpenChange(false)}
          >
            {cancelText}
          </Button>
          <Button
            ref={confirmRef}
            color="danger"
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmText}
          </Button>
        </Group>
      </div>
    </Modal>
  );
}
