import { describe, expect, it } from 'vitest';
import {
  hashPin,
  isPinVerifierValid,
  isWeakPin,
  PIN_ITERATIONS,
  verifyPin,
} from './pin.ts';

describe('PIN rules (05 §4)', () => {
  it('rejects weak PINs', () => {
    for (const pin of [
      '0000',
      '1111',
      '9999',
      '1234',
      '4321',
      '1212',
      '1987',
      '2026',
      '12a4',
      '123',
      '1234567',
    ]) {
      expect(isWeakPin(pin), pin).toBe(true);
    }
    expect(isWeakPin('4826')).toBe(false);
    expect(isWeakPin('482619')).toBe(false);
    expect(isWeakPin('2100')).toBe(false);
  });

  it('hashes with PBKDF2-SHA256 and verifies', async () => {
    const stored = await hashPin('4826', 1000);
    expect(stored.pin_iterations).toBe(1000);
    expect(atob(stored.pin_salt)).toHaveLength(16);
    expect(atob(stored.pin_hash)).toHaveLength(32);
    expect(await verifyPin('4826', stored)).toBe(true);
    expect(await verifyPin('4827', stored)).toBe(false);
    expect(PIN_ITERATIONS).toBe(150_000);
  });

  it('is deterministic for a given salt (known vector)', async () => {
    const salt = new Uint8Array(16);
    const a = await hashPin('4826', 1000, salt);
    const b = await hashPin('4826', 1000, salt);
    expect(a).toEqual(b);
    expect(a.pin_salt).toBe('AAAAAAAAAAAAAAAAAAAAAA==');
  });

  it('treats a malformed verifier as a wrong PIN instead of throwing', async () => {
    const good = await hashPin('4826', 1000);
    for (const broken of [
      { ...good, pin_salt: '!!!' },
      { ...good, pin_hash: 'not base64' },
      { ...good, pin_iterations: 0 },
      { ...good, pin_iterations: -5 },
      { ...good, pin_iterations: 1.5 },
      { ...good, pin_salt: '' },
      { ...good, pin_hash: '' },
    ]) {
      expect(await verifyPin('4826', broken)).toBe(false);
    }
  });

  it('accepts only the documented range for a stored verifier on write', async () => {
    expect(isPinVerifierValid(await hashPin('4826', 1000))).toBe(false);
    expect(isPinVerifierValid(await hashPin('4826', 100_000))).toBe(true);
    expect(
      isPinVerifierValid({ ...(await hashPin('4826', 1000)), pin_salt: '!' }),
    ).toBe(false);
    expect(
      isPinVerifierValid({
        pin_hash: 'x'.repeat(44),
        pin_salt: '!'.repeat(24),
        pin_iterations: 150_000,
      }),
    ).toBe(false);
  });
});
