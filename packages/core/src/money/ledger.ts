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
  const ordered = entries.map((entry, index) => ({ ...entry, index }));
  ordered.sort(
    (left, right) =>
      left.created_at - right.created_at || left.index - right.index,
  );
  const open: OpenDebit[] = [];
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
      while (pay > 0 && open.length > 0) {
        const head = open[0] as OpenDebit;
        if (head.remaining > pay) {
          head.remaining -= pay;
          pay = 0;
        } else {
          pay -= head.remaining;
          open.shift();
        }
      }
      if (pay > 0) {
        credit += pay;
      }
    }
  }
  const oldest = open[0];
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
