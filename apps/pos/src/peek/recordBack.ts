import { isUlid } from '@bikri/core';
import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { type PeekOrigin, parseOrigin } from './peek.ts';

export type ParentRoute =
  | '/products'
  | '/sales'
  | '/quotations'
  | '/udhaar'
  | '/suppliers';

export type RecordBack = {
  /** Full accessible/visible label for the desktop back pill. */
  label: string;
  /** Short origin name for the phone top bar. */
  shortLabel: string;
  onActivate: () => void;
  returnTo: PeekOrigin | null;
};

/** The canonical parent for a detail route; null for lists, forms and utility pages. */
export function recordBackForPath(
  pathname: string,
): { to: ParentRoute; shortLabelKey: string } | null {
  const clean = pathname.replace(/\/+$/u, '');
  const quote = /^\/quotations\/([^/]+)$/u.exec(clean);
  if (quote?.[1] && isUlid(quote[1]))
    return { to: '/quotations', shortLabelKey: 'nav.sales' };
  const match = /^\/(products|sales|udhaar|suppliers)\/([^/]+)$/u.exec(clean);
  if (!match) return null;
  const [, section, id] = match;
  if (!id || !isUlid(id)) return null;
  if (section === 'products')
    return { to: '/products', shortLabelKey: 'nav.products' };
  if (section === 'sales') return { to: '/sales', shortLabelKey: 'nav.sales' };
  if (section === 'udhaar')
    return { to: '/udhaar', shortLabelKey: 'peek.customers' };
  return { to: '/suppliers', shortLabelKey: 'nav.suppliers' };
}

export function useReturnContext(): PeekOrigin | null {
  const state = useLocation().state as unknown as
    | Record<string, unknown>
    | undefined;
  return parseOrigin(state?.bikriReturn);
}

/**
 * The record page's back destination. A return context set by `Open full` wins;
 * otherwise the page's canonical list is the fallback.
 */
export function useRecordBack(
  fallbackTo: ParentRoute | null,
  fallbackShortKey: string | null,
): RecordBack | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const router = useRouter();
  const returnTo = useReturnContext();
  const fallbackLabel = fallbackShortKey === null ? '' : t(fallbackShortKey);
  const shortLabel =
    returnTo === null
      ? fallbackLabel
      : t(returnTo.labelKey, returnTo.labelParams);
  const label = t('peek.back_to', { name: shortLabel });

  if (returnTo === null && fallbackTo === null) return null;

  return {
    label,
    shortLabel,
    returnTo,
    onActivate: () => {
      if (returnTo !== null) {
        if (returnTo.mode === 'history') {
          router.history.back();
          return;
        }
        void navigate({ href: returnTo.href, replace: true });
        return;
      }
      if (fallbackTo !== null) {
        void navigate({ to: fallbackTo, replace: true });
      }
    },
  };
}
