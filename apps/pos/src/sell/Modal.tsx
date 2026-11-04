import * as Dialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

const overlayClass = 'bikri-overlay fixed inset-0 z-40 bg-text/40';
const base =
  'bikri-dialog fixed inset-0 z-50 m-auto flex h-fit max-h-[calc(100%-2rem)] flex-col gap-4 overflow-y-auto rounded-modal bg-surface p-4 text-text shadow-modal';
const SIZES = {
  normal: `${base} w-[min(32rem,calc(100%-2rem))]`,
  wide: `${base} w-[min(40rem,calc(100%-2rem))]`,
  // Full screen below 768 px (pay modal, screens/06).
  full: `${base} w-[min(56rem,calc(100%-2rem))] max-md:m-0 max-md:h-full max-md:max-h-full max-md:w-full max-md:rounded-none`,
  // Sale complete: centered like screens/07, but full-screen on phones.
  done: `${base} w-[min(36rem,calc(100%-2rem))] max-md:m-0 max-md:h-full max-md:max-h-full max-md:w-full max-md:rounded-none`,
  // A form sheet: rises from the bottom on phones, a compact dialog on larger screens.
  sheet: `${base} w-[min(32rem,calc(100%-2rem))] max-md:mt-auto max-md:mb-0 max-md:max-h-[92dvh] max-md:w-full max-md:rounded-b-none max-md:pt-6 max-md:pb-0`,
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
  done = false,
  sheet = false,
  header,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
  full?: boolean;
  /** Sale complete: compact centered dialog on desktop, full screen on phones. */
  done?: boolean;
  /** Phone: a bottom sheet; from 768 px: a compact dialog. */
  sheet?: boolean;
  /** Extra content next to the title (e.g. the total to pay). */
  header?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlayClass} />
        <Dialog.Content
          className={
            SIZES[
              done
                ? 'done'
                : full
                  ? 'full'
                  : sheet
                    ? 'sheet'
                    : wide
                      ? 'wide'
                      : 'normal'
            ]
          }
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          {sheet ? (
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-border-strong md:hidden"
            />
          ) : null}
          <div className="flex flex-wrap items-baseline justify-between gap-2 pe-12">
            <Dialog.Title className="text-title">{title}</Dialog.Title>
            {header}
          </div>
          <Dialog.Close asChild>
            <button
              type="button"
              aria-label={t('ui.close_dialog')}
              className="absolute end-2 top-2 flex size-11 items-center justify-center rounded-control text-text-muted transition-colors hover:bg-surface-2"
            >
              <span aria-hidden="true" className="text-title leading-none">
                ×
              </span>
            </button>
          </Dialog.Close>
          {description ? (
            <Dialog.Description className="text-small text-text-muted">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
