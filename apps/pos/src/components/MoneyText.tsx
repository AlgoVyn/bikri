import { formatMoney, type NumberGrouping } from '@bikri/core';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { maskMoney } from '../lib/money.ts';
import { useMoneyGrouping } from './MoneyGrouping.tsx';
import { usePrivacyActive } from './privacy.tsx';

/**
 * Money with a deliberate hierarchy (docs/08 §2): the rupee mark and paisa are secondary,
 * the integer amount carries the weight of its surrounding label. Text content stays
 * exactly `formatMoney(...)` so copy, export and screen readers are unchanged.
 *
 * In privacy mode the amount is replaced by a fixed-width mask before rendering, so the
 * real value never reaches the DOM.
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
  const privacy = usePrivacyActive();
  const { t } = useTranslation();
  if (privacy) {
    return (
      <bdi dir="ltr" className="whitespace-nowrap tabular-nums">
        <span className="sr-only">{t('privacy.hidden')}</span>
        <span aria-hidden="true">{maskMoney(paisa)}</span>
      </bdi>
    );
  }
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

/**
 * Display-only money formatter for translated sentences and toasts. Keeps the raw
 * `formatShopMoney` for print, PDF/CSV, labels and reminder messages.
 */
export function useDisplayMoney(): (paisa: number) => string {
  const grouping = useMoneyGrouping();
  const privacy = usePrivacyActive();
  return useMemo(
    () => (paisa: number) =>
      privacy ? maskMoney(paisa) : formatMoney(paisa, grouping),
    [grouping, privacy],
  );
}
