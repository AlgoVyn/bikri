import { formatMoney, type NumberGrouping } from '@bikri/core';

export function MoneyText({
  paisa,
  grouping = 'intl',
}: {
  paisa: number;
  grouping?: NumberGrouping;
}) {
  return (
    <bdi dir="ltr" className="whitespace-nowrap font-mono tabular-nums">
      {formatMoney(paisa, grouping)}
    </bdi>
  );
}
