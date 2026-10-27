/** Code 128 subset B/C encoder (screens/20); no dependency. */

const PATTERNS = [
  '212222',
  '222122',
  '222221',
  '121223',
  '121322',
  '131222',
  '122213',
  '122312',
  '132212',
  '221213',
  '221312',
  '231212',
  '112232',
  '122132',
  '122231',
  '113222',
  '123122',
  '123221',
  '223211',
  '221132',
  '221231',
  '213212',
  '223112',
  '312131',
  '311222',
  '321122',
  '321221',
  '312212',
  '322112',
  '322211',
  '212123',
  '212321',
  '232121',
  '111323',
  '131123',
  '131321',
  '112313',
  '132113',
  '132311',
  '211313',
  '231113',
  '231311',
  '112133',
  '112331',
  '132131',
  '113123',
  '113321',
  '133121',
  '313121',
  '211331',
  '231131',
  '213113',
  '213311',
  '213131',
  '311123',
  '311321',
  '331121',
  '312113',
  '312311',
  '332111',
  '314111',
  '221411',
  '431111',
  '111224',
  '111422',
  '121124',
  '121421',
  '141122',
  '141221',
  '112214',
  '112412',
  '122114',
  '122411',
  '142112',
  '142211',
  '241211',
  '221114',
  '413111',
  '241112',
  '134111',
  '111242',
  '121142',
  '121241',
  '114212',
  '124112',
  '124211',
  '411212',
  '421112',
  '421211',
  '212141',
  '214121',
  '412121',
  '111143',
  '111341',
  '131141',
  '114113',
  '114311',
  '411113',
  '411311',
  '113141',
  '114131',
  '311141',
  '411131',
  '211412',
  '211214',
  '211232',
  '2331112',
] as const;

const START_B = 104;
const START_C = 105;
const CODE_B = 100;
const STOP = 106;

export type Code128Bar = { x: number; width: number };

export type Code128 = {
  value: string;
  /** Start and data symbols (the switch to B is data), excluding check and stop. */
  symbols: number[];
  check: number;
  /** Modules including the 10-module quiet zones on both sides. */
  modules: number;
  /** Bars in module units, starting after the left quiet zone. */
  bars: Code128Bar[];
};

export class BarcodeError extends Error {
  readonly code: 'empty' | 'charset';
  constructor(code: BarcodeError['code']) {
    super(code);
    this.name = 'BarcodeError';
    this.code = code;
  }
}

function dataSymbols(value: string): { start: number; symbols: number[] } {
  if (value.length === 0) throw new BarcodeError('empty');
  if (/^\d{2,}$/u.test(value)) {
    const symbols: number[] = [];
    let index = 0;
    for (; index + 1 < value.length; index += 2)
      symbols.push(Number(value.slice(index, index + 2)));
    if (index < value.length) {
      symbols.push(CODE_B, value.charCodeAt(index) - 32);
    }
    return { start: START_C, symbols };
  }
  const symbols: number[] = [];
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) throw new BarcodeError('charset');
    symbols.push(code - 32);
  }
  return { start: START_B, symbols };
}

/** Encode a value to Code 128 symbols, check digit, modules and bar geometry. */
export function encodeCode128(value: string): Code128 {
  const { start, symbols: data } = dataSymbols(value);
  let sum = start;
  data.forEach((symbol, index) => {
    sum += (index + 1) * symbol;
  });
  const check = sum % 103;
  const symbols = [start, ...data];
  const all = [...symbols, check, STOP];
  const widths = all.map((symbol) => PATTERNS[symbol] ?? '');
  const modules =
    widths.reduce(
      (total, pattern) =>
        total + [...pattern].reduce((sum, width) => sum + Number(width), 0),
      0,
    ) + 20;
  const bars: Code128Bar[] = [];
  let x = 10;
  for (const pattern of widths) {
    let bar = true;
    for (const width of pattern) {
      const size = Number(width);
      if (bar) bars.push({ x, width: size });
      x += size;
      bar = !bar;
    }
  }
  return { value, symbols, check, modules, bars };
}

export function barcodeModules(value: string): number {
  return encodeCode128(value).modules;
}
