import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

const overlayClass = 'fixed inset-0 z-40 bg-text/40';
const contentClass =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] w-[min(32rem,calc(100%-2rem))] flex-col gap-4 overflow-y-auto rounded-modal bg-surface p-4 text-text shadow-modal';

/** A titled modal dialog (focus trap, Esc closes). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={
            wide
              ? `${contentClass} w-[min(40rem,calc(100%-2rem))]`
              : contentClass
          }
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <Dialog.Title className="text-title">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description>{description}</Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
