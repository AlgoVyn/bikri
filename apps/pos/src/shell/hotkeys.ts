import { useEffect, useRef } from 'react';

/** Single-key and Alt shortcuts never fire while typing in a field. */
export function ignoresHotkey(target: EventTarget | null): boolean {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/** True while a modal dialog owns the screen; page shortcuts must not act underneath it. */
export function dialogOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.querySelector(
      '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]',
    ) !== null
  );
}

/**
 * A page shortcut. Listens in the capture phase and marks the event handled, so it wins over
 * the shell's own shortcut for the same key (the shell skips `defaultPrevented` events).
 * A page shortcut is inert while a modal is open unless the hook lives inside that dialog.
 */
export function useHotkey(
  match: (event: KeyboardEvent) => boolean,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; inFields?: boolean; inDialog?: boolean } = {},
): void {
  const ref = useRef({ match, handler });
  ref.current = { match, handler };
  const enabled = options.enabled ?? true;
  const inFields = options.inFields ?? false;
  const inDialog = options.inDialog ?? false;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!inFields && ignoresHotkey(event.target)) return;
      if (!inDialog && dialogOpen()) return;
      if (!ref.current.match(event)) return;
      event.preventDefault();
      ref.current.handler(event);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, inFields, inDialog]);
}

/** Plain letter key without modifiers (`n`, `e`). */
export const plainKey = (key: string) => (event: KeyboardEvent) =>
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === key;
