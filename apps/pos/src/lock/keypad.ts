import type { KeypadLayout } from '../shell/devicePrefs.ts';

/**
 * The 3×3 digit grid of the lock keypad. `phone` puts 1-2-3 on top; `computer`
 * mirrors a physical numpad with 7-8-9 on top. Clear/0/⌫ stay in the last row.
 */
export function keypadDigits(layout: KeypadLayout): string[] {
  return layout === 'computer'
    ? ['7', '8', '9', '4', '5', '6', '1', '2', '3']
    : ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
}

const URDU_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

/** The digit a keyboard key stands for (ASCII or Urdu-Indic), or null. */
export function digitOfKey(key: string): string | null {
  if (key >= '0' && key <= '9' && key.length === 1) return key;
  const index = URDU_DIGITS.indexOf(key);
  return index >= 0 ? String(index) : null;
}

/**
 * A key event that belongs to a text field, an open menu/dialog or a shortcut is not a
 * PIN key: typing `Ctrl+0` in another control must not add a digit to the lock screen.
 */
export function isPinKeyBlocked(event: {
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
}): boolean {
  return Boolean(
    event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.defaultPrevented ||
      event.isComposing,
  );
}

/** True when focus is in a field or an overlay that owns its own keyboard input. */
export function ownsKeyTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element))
    return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="dialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}
