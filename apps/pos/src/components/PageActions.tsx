import { Link } from '@tanstack/react-router';
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { MoreIcon } from './icons.tsx';

export type PageActionItem = {
  label: string;
  disabled?: boolean;
  /** Destructive items stay in the overflow but carry the danger colour. */
  tone?: 'danger';
} & (
  | { onSelect: () => void; to?: undefined }
  | { to: string; onSelect?: undefined }
);

const itemClass =
  'flex min-h-11 w-full items-center gap-2 rounded-control px-2 text-start text-small text-text transition-colors duration-150 hover:bg-surface-2 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-muted';
const dangerItemClass = `${itemClass} text-danger`;

/**
 * Page action hierarchy (docs/08 §2): one filled primary, quiet secondaries, everything
 * else in the More disclosure. Navigation items stay real links; actions stay buttons.
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
  /** Accessible name for the More trigger; falls back to the shared “More” label. */
  moreLabel?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const menuId = useId();
  const label = moreLabel ?? t('nav.more');

  const focusItem = (index: number) => {
    requestAnimationFrame(() => {
      const items = itemRefs.current.filter(
        (item): item is HTMLElement => item !== null,
      );
      const target = index < 0 ? items.at(-1) : items[index];
      target?.focus();
    });
  };

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const inside = ref.current?.contains(document.activeElement) ?? false;
      setOpen(false);
      if (inside) triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onEscape);
    };
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter(
      (item): item is HTMLElement => item !== null,
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  if (primary === undefined && secondary === undefined && more.length === 0) {
    return null;
  }

  return (
    <div className="flex w-full flex-wrap items-center gap-2 md:ms-auto md:w-auto md:justify-end">
      {secondary}
      {more.length > 0 ? (
        <div className="relative" ref={ref}>
          <button
            ref={triggerRef}
            type="button"
            data-testid="page-actions-more"
            className="flex size-11 items-center justify-center rounded-control border border-border-strong bg-surface text-text transition-colors duration-150 hover:bg-surface-2"
            aria-label={label}
            aria-haspopup="true"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
              event.preventDefault();
              setOpen(true);
              focusItem(event.key === 'ArrowDown' ? 0 : -1);
            }}
          >
            <MoreIcon />
          </button>
          {open ? (
            <div
              id={menuId}
              role="toolbar"
              aria-orientation="vertical"
              aria-label={label}
              className="bikri-menu absolute end-0 top-12 z-30 flex w-56 flex-col gap-0.5 rounded-card border border-border bg-surface p-1 shadow-modal"
              onKeyDown={onMenuKeyDown}
            >
              {more.map((item, index) =>
                item.to !== undefined ? (
                  <Link
                    key={item.label}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    to={item.to as never}
                    className={
                      item.tone === 'danger' ? dangerItemClass : itemClass
                    }
                    aria-disabled={item.disabled || undefined}
                    tabIndex={item.disabled ? -1 : undefined}
                    onClick={(event) => {
                      if (item.disabled) {
                        event.preventDefault();
                        return;
                      }
                      setOpen(false);
                    }}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <button
                    key={item.label}
                    ref={(element) => {
                      itemRefs.current[index] = element;
                    }}
                    type="button"
                    disabled={item.disabled}
                    className={
                      item.tone === 'danger' ? dangerItemClass : itemClass
                    }
                    onClick={() => {
                      item.onSelect?.();
                      setOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {primary}
    </div>
  );
}
