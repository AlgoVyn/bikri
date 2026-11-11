import { describe, expect, it } from 'vitest';
import { keypadDigits } from './keypad.ts';

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
