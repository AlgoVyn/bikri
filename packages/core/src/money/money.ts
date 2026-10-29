/**
 * Integer money primitives (07 §1).
 * Products use BigInt so qty × price × bp can exceed 2^53. Results are numbers.
 * Division rounds half away from zero.
 */

export function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer`);
  }
}

/** Round numerator ÷ denominator, half away from zero. */
export function roundHalfAway(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) {
    throw new RangeError('division by zero');
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  const magnitude = remainder * 2n >= absDenominator ? quotient + 1n : quotient;
  const signed = negative ? -magnitude : magnitude;
  if (
    signed > BigInt(Number.MAX_SAFE_INTEGER) ||
    signed < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError('result exceeds safe integer');
  }
  return Number(signed);
}

/** Exact a × b ÷ c, round half away from zero. */
export function mulDivRound(a: number, b: number, c: number): number {
  assertSafeInteger(a, 'a');
  assertSafeInteger(b, 'b');
  assertSafeInteger(c, 'c');
  return roundHalfAway(BigInt(a) * BigInt(b), BigInt(c));
}

/** Round `value` to a multiple of `step` (paisa). */
export function roundTo(value: number, step: number): number {
  assertSafeInteger(value, 'value');
  assertSafeInteger(step, 'step');
  if (step <= 0) {
    throw new RangeError('step must be positive');
  }
  const rounded = mulDivRound(value, 1, step) * step;
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError('rounded value exceeds safe integer');
  }
  return rounded;
}

export function sumSafe(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    assertSafeInteger(value, 'value');
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new RangeError('sum exceeds safe integer');
    }
  }
  return total;
}

export function subSafe(left: number, right: number): number {
  assertSafeInteger(left, 'left');
  assertSafeInteger(right, 'right');
  const difference = left - right;
  if (!Number.isSafeInteger(difference)) {
    throw new RangeError('difference exceeds safe integer');
  }
  return difference;
}

/**
 * Largest-remainder split. Ties go to the lower index.
 * Sign of `amount` is applied at the end. W = 0 yields all zeros.
 */
export function allocate(amount: number, weights: readonly number[]): number[] {
  assertSafeInteger(amount, 'amount');
  const width = weights.length;
  if (width === 0) {
    return [];
  }
  const rows: { weight: bigint; index: number }[] = [];
  let totalWeight = 0n;
  let index = 0;
  for (const weight of weights) {
    assertSafeInteger(weight, 'weight');
    if (weight < 0) {
      throw new RangeError('weights must be non-negative');
    }
    const bits = BigInt(weight);
    rows.push({ weight: bits, index });
    totalWeight += bits;
    index += 1;
  }
  if (totalWeight === 0n) {
    return rows.map(() => 0);
  }
  const negative = amount < 0;
  const absolute = negative ? -BigInt(amount) : BigInt(amount);
  const bases: bigint[] = [];
  const remainders: { remainder: bigint; index: number }[] = [];
  let baseSum = 0n;
  for (const row of rows) {
    const product = absolute * row.weight;
    const base = product / totalWeight;
    const remainder = product % totalWeight;
    bases.push(base);
    remainders.push({ remainder, index: row.index });
    baseSum += base;
  }
  let leftover = absolute - baseSum;
  remainders.sort((left, right) => {
    if (left.remainder === right.remainder) {
      return left.index - right.index;
    }
    return left.remainder > right.remainder ? -1 : 1;
  });
  const extras = Array.from({ length: width }, () => 0n);
  for (const row of remainders) {
    if (leftover === 0n) {
      break;
    }
    extras[row.index] = 1n;
    leftover -= 1n;
  }
  const shares: number[] = [];
  for (let shareIndex = 0; shareIndex < width; shareIndex += 1) {
    const base = bases[shareIndex] as bigint;
    const extra = extras[shareIndex] as bigint;
    const magnitude = base + extra;
    const signed = negative ? -magnitude : magnitude;
    shares.push(Number(signed));
  }
  return shares;
}

/** Quick-cash chips in paisa: ceil to Rs 500, 1,000 and 5,000 (07 §4). */
const CASH_CHIP_STEPS = [50_000, 100_000, 500_000] as const;

export function cashChips(duePaisa: number): number[] {
  assertSafeInteger(duePaisa, 'due');
  if (duePaisa <= 0) {
    return [];
  }
  const chips: number[] = [];
  for (const step of CASH_CHIP_STEPS) {
    const count = (BigInt(duePaisa) + BigInt(step) - 1n) / BigInt(step);
    const rounded = count * BigInt(step);
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) continue;
    const chip = Number(rounded);
    if (chip !== duePaisa && !chips.includes(chip)) {
      chips.push(chip);
    }
  }
  chips.sort((left, right) => left - right);
  return chips;
}
