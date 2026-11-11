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
