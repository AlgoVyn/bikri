import { assertSafeInteger, sumSafe } from './money.ts';

export interface LedgerAmount {
  amount: number;
  created_at: number;
}

export interface CreditLimitResult {
  balance_after: number;
  over_by: number;
  over_limit: boolean;
  hard_blocked: boolean;
}

/** Party balance is the sum of ledger amounts (07 §5). */
export function partyBalance(amounts: readonly number[]): number {
  return sumSafe(amounts);
}

interface OpenDebit {
  created_at: number;
  remaining: number;
}

/**
 * Earliest debit not fully covered, walking oldest-first.
 * A credit that arrives before a debit reduces that later debit.
 * Returns null when the party is not in debt.
 */
export function oldestUnpaidAt(
  entries: readonly LedgerAmount[],
): number | null {
  // `Array.prototype.sort` is stable (ES2019), so equal timestamps keep their input
  // order without cloning every entry into an index wrapper.
  const ordered = [...entries];
  ordered.sort((left, right) => left.created_at - right.created_at);
  const open: OpenDebit[] = [];
  // A head cursor makes clearing an old debit O(1); `shift()` moved the whole array.
  let head = 0;
  let credit = 0;
  for (const entry of ordered) {
    assertSafeInteger(entry.amount, 'amount');
    assertSafeInteger(entry.created_at, 'created_at');
    if (entry.amount === 0) {
      throw new RangeError('ledger amount must be non-zero');
    }
    if (entry.amount > 0) {
      let debit = entry.amount;
      if (credit > 0) {
        const used = Math.min(credit, debit);
        credit -= used;
        debit -= used;
      }
      if (debit > 0) {
        open.push({ created_at: entry.created_at, remaining: debit });
      }
    } else {
      let pay = -entry.amount;
      while (pay > 0 && head < open.length) {
        const current = open[head] as OpenDebit;
        if (current.remaining > pay) {
          current.remaining -= pay;
          pay = 0;
        } else {
          pay -= current.remaining;
          head += 1;
        }
      }
      if (pay > 0) {
        credit += pay;
      }
    }
  }
  const oldest = open[head];
  return oldest === undefined ? null : oldest.created_at;
}

/** Credit-limit warning and hard block (07 §4.1). `creditLimit` null means no limit. */
export function creditLimitCheck(
  currentBalance: number,
  udhaarPart: number,
  creditLimit: number | null,
  hardLimit: boolean,
): CreditLimitResult {
  assertSafeInteger(currentBalance, 'currentBalance');
  assertSafeInteger(udhaarPart, 'udhaarPart');
  if (creditLimit !== null) {
    assertSafeInteger(creditLimit, 'creditLimit');
    if (creditLimit < 0)
      throw new RangeError('creditLimit must be non-negative');
  }
  const balanceAfter = currentBalance + udhaarPart;
  if (!Number.isSafeInteger(balanceAfter)) {
    throw new RangeError('balance exceeds safe integer');
  }
  if (creditLimit === null || balanceAfter <= creditLimit) {
    return {
      balance_after: balanceAfter,
      over_by: 0,
      over_limit: false,
      hard_blocked: false,
    };
  }
  return {
    balance_after: balanceAfter,
    over_by: balanceAfter - creditLimit,
    over_limit: true,
    hard_blocked: hardLimit,
  };
}
