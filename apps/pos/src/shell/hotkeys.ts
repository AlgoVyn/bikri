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

/**
 * A page shortcut. Listens in the capture phase and marks the event handled, so it wins over
 * the shell's own shortcut for the same key (the shell skips `defaultPrevented` events).
 */
export function useHotkey(
  match: (event: KeyboardEvent) => boolean,
  handler: (event: KeyboardEvent) => void,
  options: { enabled?: boolean; inFields?: boolean } = {},
): void {
  const ref = useRef({ match, handler });
  ref.current = { match, handler };
  const enabled = options.enabled ?? true;
  const inFields = options.inFields ?? false;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!inFields && ignoresHotkey(event.target)) return;
      if (!ref.current.match(event)) return;
      event.preventDefault();
      ref.current.handler(event);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled, inFields]);
}

/** Plain letter key without modifiers (`n`, `e`). */
export const plainKey = (key: string) => (event: KeyboardEvent) =>
  !event.altKey &&
  !event.ctrlKey &&
  !event.metaKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === key;
