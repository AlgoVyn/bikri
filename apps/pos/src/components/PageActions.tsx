import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { MoreIcon } from './icons.tsx';

export type PageActionItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
};

const itemClass =
  'flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start text-small text-text transition-colors duration-150 hover:bg-surface-2 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-muted';

/**
 * Page action hierarchy (docs/08 §2): one filled primary, quiet secondaries, everything
 * else in the More menu. The menu keeps real buttons (not menu items) so keyboard and
 * existing tests behave like the rest of the app.
 */
export function PageActions({
  primary,
  secondary,
  more = [],
  moreLabel,
}: {
  primary?: ReactNode;
  secondary?: ReactNode;
  more?: readonly PageActionItem[];
  /** Accessible name for the More trigger; required when there are overflow actions. */
  moreLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  if (primary === undefined && secondary === undefined && more.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 md:ms-auto md:w-auto md:justify-end">
      {secondary}
      {more.length > 0 ? (
        <div className="relative" ref={ref}>
          <button
            type="button"
            className="flex size-11 items-center justify-center rounded-control border border-border-strong bg-surface text-text transition-colors duration-150 hover:bg-surface-2"
            aria-label={moreLabel}
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
          >
            <MoreIcon />
          </button>
          {open ? (
            <div
              id={menuId}
              className="absolute end-0 top-12 z-30 flex w-56 flex-col gap-0.5 rounded-card border border-border bg-surface p-1 shadow-modal"
            >
              {more.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  className={itemClass}
                  onClick={() => {
                    item.onSelect();
                    setOpen(false);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {primary}
    </div>
  );
}
