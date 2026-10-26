const URDU_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** Arabic decimal separator (U+066B) and thousands separator (U+066C). */
const ARABIC_DECIMAL = '\u066B';
const ARABIC_THOUSANDS = '\u066C';

/**
 * Map Urdu (U+06F0–U+06F9) and Arabic-Indic (U+0660–U+0669) digits to 0–9.
 * Other characters are unchanged.
 */
export function normaliseDigits(input: string): string {
  let out = '';
  for (const char of input) {
    const urdu = URDU_DIGITS.indexOf(char);
    if (urdu >= 0) {
      out += String(urdu);
      continue;
    }
    const arabic = ARABIC_INDIC_DIGITS.indexOf(char);
    if (arabic >= 0) {
      out += String(arabic);
      continue;
    }
    out += char;
  }
  return out;
}

/** Digits plus Arabic decimal/thousands separators used in Urdu amounts. */
export function normaliseNumericText(input: string): string {
  return normaliseDigits(input)
    .replaceAll(ARABIC_THOUSANDS, '')
    .replaceAll(ARABIC_DECIMAL, '.');
}
