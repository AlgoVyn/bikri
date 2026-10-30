import { formatMoney, type NumberGrouping } from '@bikri/core';
import { useMoneyGrouping } from './MoneyGrouping.tsx';

export function MoneyText({
  paisa,
  grouping,
}: {
  paisa: number;
  /** Explicit override (admin/export surfaces outside a shop); otherwise the shop setting. */
  grouping?: NumberGrouping;
}) {
  const shopGrouping = useMoneyGrouping();
  return (
    <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
      {formatMoney(paisa, grouping ?? shopGrouping)}
    </bdi>
  );
}
