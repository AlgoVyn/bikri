import { formatMoney, type NumberGrouping } from '@bikri/core';
import { useMoneyGrouping } from './MoneyGrouping.tsx';

/**
 * Money with a deliberate hierarchy (docs/08 §2): the rupee mark and paisa are secondary,
 * the integer amount carries the weight of its surrounding label. Text content stays
 * exactly `formatMoney(...)` so copy, export and screen readers are unchanged.
 */
export function MoneyText({
  paisa,
  grouping,
}: {
  paisa: number;
  /** Explicit override (admin/export surfaces outside a shop); otherwise the shop setting. */
  grouping?: NumberGrouping;
}) {
  const shopGrouping = useMoneyGrouping();
  const text = formatMoney(paisa, grouping ?? shopGrouping);
  const match = /^(−)?Rs (.+)$/u.exec(text);
  if (!match) {
    return (
      <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
        {text}
      </bdi>
    );
  }
  const [, minus, body] = match;
  const dot = body?.lastIndexOf('.') ?? -1;
  const whole = dot > 0 ? body?.slice(0, dot) : body;
  const fraction = dot > 0 ? body?.slice(dot) : '';
  return (
    <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
      {minus}
      <span className="align-baseline text-[0.7em] font-normal">Rs</span>{' '}
      {whole}
      {fraction ? (
        <span className="align-baseline text-[0.75em] font-normal">
          {fraction}
        </span>
      ) : null}
    </bdi>
  );
}
