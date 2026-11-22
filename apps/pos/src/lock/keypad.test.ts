import { describe, expect, it } from 'vitest';
import {
  digitOfKey,
  isPinKeyBlocked,
  keypadDigits,
  ownsKeyTarget,
} from './keypad.ts';

describe('lock keypad layout', () => {
  it('puts 1-2-3 on top for the phone layout', () => {
    expect(keypadDigits('phone')).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
    ]);
  });

  it('puts 7-8-9 on top for the computer numpad layout', () => {
    expect(keypadDigits('computer')).toEqual([
      '7',
      '8',
      '9',
      '4',
      '5',
      '6',
      '1',
      '2',
      '3',
    ]);
  });
});

describe('lock keyboard guards (SYNC-M4)', () => {
  it('maps ASCII and Urdu-Indic digits only', () => {
    expect(digitOfKey('7')).toBe('7');
    expect(digitOfKey('0')).toBe('0');
    expect(digitOfKey('۵')).toBe('5');
    expect(digitOfKey('a')).toBeNull();
    expect(digitOfKey('Enter')).toBeNull();
  });

  it('ignores shortcuts, composition and default-prevented keys', () => {
    expect(isPinKeyBlocked({ ctrlKey: true })).toBe(true);
    expect(isPinKeyBlocked({ metaKey: true })).toBe(true);
    expect(isPinKeyBlocked({ altKey: true })).toBe(true);
    expect(isPinKeyBlocked({ isComposing: true })).toBe(true);
    expect(isPinKeyBlocked({ defaultPrevented: true })).toBe(true);
    expect(isPinKeyBlocked({})).toBe(false);
  });

  it('leaves text fields and open overlays to their own keyboard handling', () => {
    const input = document.createElement('input');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const button = document.createElement('button');
    document.body.append(input, menu, button);
    try {
      expect(ownsKeyTarget(input)).toBe(true);
      expect(ownsKeyTarget(menu)).toBe(true);
      expect(ownsKeyTarget(button)).toBe(false);
      expect(ownsKeyTarget(document.body)).toBe(false);
      expect(ownsKeyTarget(null)).toBe(false);
    } finally {
      input.remove();
      menu.remove();
      button.remove();
    }
  });
});
