import { normaliseDigits } from './digits.ts';

export type PhoneKind = 'mobile' | 'any';

export type ParsedPhone = {
  e164: string;
  display: string;
  mobile: boolean;
};

/** Karachi, Lahore, Islamabad, Faisalabad — 2-digit area codes. */
const AREA_CODES_2 = new Set(['21', '42', '51', '61']);

function compact(raw: string): { plus: boolean; digits: string } | null {
  const normalised = normaliseDigits(raw);
  let plus = false;
  let digits = '';
  for (const char of normalised) {
    if (char >= '0' && char <= '9') {
      digits += char;
      continue;
    }
    if (char === '+') {
      if (plus || digits.length > 0) {
        return null;
      }
      plus = true;
      continue;
    }
    if (
      char === ' ' ||
      char === '-' ||
      char === '(' ||
      char === ')' ||
      char === '.'
    ) {
      continue;
    }
    return null;
  }
  return { plus, digits };
}

function mobileFromNsn(nsn: string): ParsedPhone | null {
  if (!/^3\d{9}$/u.test(nsn)) {
    return null;
  }
  const national = `0${nsn}`;
  return {
    e164: `+92${nsn}`,
    display: `${national.slice(0, 4)} ${national.slice(4)}`,
    mobile: true,
  };
}

function formatLandline(national: string): string {
  const area = national.slice(1, 3);
  if (AREA_CODES_2.has(area)) {
    return `${national.slice(0, 3)} ${national.slice(3)}`;
  }
  return `${national.slice(0, 4)} ${national.slice(4)}`;
}

function landlineFromNsn(nsn: string): ParsedPhone | null {
  if (!/^\d{9,10}$/u.test(nsn) || nsn.startsWith('3')) {
    return null;
  }
  const national = `0${nsn}`;
  return {
    e164: `+92${nsn}`,
    display: formatLandline(national),
    mobile: false,
  };
}

/**
 * Normalise a Pakistan phone number.
 * `mobile` accepts 03 / 3 / +923 / 923 and stores E.164 `+923…`, displayed `0300 1234567`.
 * `any` also accepts landlines (10–11 national digits).
 */
export function parsePkPhone(
  raw: string,
  kind: PhoneKind = 'mobile',
): ParsedPhone | null {
  const parsed = compact(raw);
  if (parsed === null || parsed.digits === '') {
    return null;
  }
  const { plus, digits } = parsed;
  if (plus && !digits.startsWith('92')) {
    return null;
  }

  let nsn: string | null = null;
  if (plus || digits.startsWith('92')) {
    if (!digits.startsWith('92')) {
      return null;
    }
    const rest = digits.slice(2);
    if (rest.length === 10 || rest.length === 9) {
      nsn = rest;
    } else {
      return null;
    }
  } else if (
    digits.startsWith('0') &&
    (digits.length === 11 || digits.length === 10)
  ) {
    nsn = digits.slice(1);
  } else if (digits.startsWith('3') && digits.length === 10) {
    nsn = digits;
  } else {
    return null;
  }

  const mobile = mobileFromNsn(nsn);
  if (mobile !== null) {
    return mobile;
  }
  if (kind !== 'any') {
    return null;
  }
  return landlineFromNsn(nsn);
}

export function whatsAppUrl(phone: ParsedPhone): string | null {
  if (!phone.mobile) {
    return null;
  }
  return `https://wa.me/${phone.e164.slice(1)}`;
}
