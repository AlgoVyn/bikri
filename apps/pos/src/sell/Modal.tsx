import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

const overlayClass = 'fixed inset-0 z-40 bg-text/40';
const base =
  'fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] flex-col gap-4 overflow-y-auto rounded-modal bg-surface p-4 text-text shadow-modal';
const SIZES = {
  normal: `${base} w-[min(32rem,calc(100%-2rem))]`,
  wide: `${base} w-[min(40rem,calc(100%-2rem))]`,
  // Full screen below 768 px (pay modal, screens/06).
  full: `${base} w-[min(40rem,calc(100%-2rem))] max-md:m-0 max-md:h-full max-md:max-h-full max-md:w-full max-md:rounded-none`,
} as const;

/** A titled modal dialog (focus trap, Esc closes). */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
  full = false,
  header,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  full?: boolean;
  /** Extra content next to the title (e.g. the total to pay). */
  header?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={SIZES[full ? 'full' : wide ? 'wide' : 'normal']}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <Dialog.Title className="text-title">{title}</Dialog.Title>
            {header}
          </div>
          {description ? (
            <Dialog.Description>{description}</Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
