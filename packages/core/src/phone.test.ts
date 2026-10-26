import { describe, expect, it } from 'vitest';
import { parsePkPhone, whatsAppUrl } from './phone.ts';

describe('parsePkPhone', () => {
  it('normalises mobile numbers to E.164 and 0300 1234567', () => {
    const expected = {
      e164: '+923001234567',
      display: '0300 1234567',
      mobile: true,
    };
    expect(parsePkPhone('03001234567')).toEqual(expected);
    expect(parsePkPhone('0300 1234567')).toEqual(expected);
    expect(parsePkPhone('0300-1234567')).toEqual(expected);
    expect(parsePkPhone('3001234567')).toEqual(expected);
    expect(parsePkPhone('+923001234567')).toEqual(expected);
    expect(parsePkPhone('+92 300 1234567')).toEqual(expected);
    expect(parsePkPhone('923001234567')).toEqual(expected);
    expect(parsePkPhone('۰۳۰۰۱۲۳۴۵۶۷')).toEqual(expected);
  });

  it('rejects landlines when kind is mobile', () => {
    expect(parsePkPhone('04235761234')).toBeNull();
    expect(parsePkPhone('04235761234', 'mobile')).toBeNull();
    expect(parsePkPhone('12345')).toBeNull();
    expect(parsePkPhone('+14155552671')).toBeNull();
  });

  it('accepts landlines for kind any and groups known area codes', () => {
    expect(parsePkPhone('042 35761234', 'any')).toEqual({
      e164: '+924235761234',
      display: '042 35761234',
      mobile: false,
    });
    expect(parsePkPhone('+924235761234', 'any')).toEqual({
      e164: '+924235761234',
      display: '042 35761234',
      mobile: false,
    });
    expect(parsePkPhone('0511234567', 'any')).toEqual({
      e164: '+92511234567',
      display: '051 1234567',
      mobile: false,
    });
    expect(parsePkPhone('0413123456', 'any')).toEqual({
      e164: '+92413123456',
      display: '0413 123456',
      mobile: false,
    });
  });

  it('offers WhatsApp only for mobile numbers', () => {
    const mobile = parsePkPhone('03001234567');
    const landline = parsePkPhone('04235761234', 'any');
    expect(mobile).not.toBeNull();
    expect(landline).not.toBeNull();
    if (mobile === null || landline === null) {
      return;
    }
    expect(whatsAppUrl(mobile)).toBe('https://wa.me/923001234567');
    expect(whatsAppUrl(landline)).toBeNull();
  });
});
