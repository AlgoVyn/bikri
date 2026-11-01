import { Navigate, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, pageClass } from '../components/classes.ts';
import { ProductsIcon } from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  ledgerContext,
  SUGGESTED_PRODUCTS,
  saveNewProduct,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';

/** Electronics starter list (screens/04 first run): names only, the owner sets prices. */
export function SuggestedPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const [picked, setPicked] = useState<Record<string, number | null>>({});
  const [pending, setPending] = useState(false);
  const chosen = Object.entries(picked).filter(
    ([, price]) => price !== null,
  ) as [string, number][];
  if (!can('catalog.edit') || readOnly)
    return <Navigate to="/products" replace />;

  return (
    <div className={pageClass('focused', 'gap-4')}>
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<ProductsIcon />}
        title={t('suggested.title')}
      />
      <p className="text-text-muted">{t('suggested.hint')}</p>
      <ul className="flex flex-col gap-2">
        {SUGGESTED_PRODUCTS.map((name) => {
          const on = name in picked;
          return (
            <li
              key={name}
              className="flex flex-wrap items-end gap-3 rounded-card border border-border bg-surface p-3"
            >
              <label className="flex min-h-11 flex-1 items-center gap-3">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={on}
                  onChange={(e) =>
                    setPicked((p) => {
                      const next = { ...p };
                      if (e.target.checked) next[name] = null;
                      else delete next[name];
                      return next;
                    })
                  }
                />
                {name}
              </label>
              {on ? (
                <div className="w-40">
                  <MoneyInput
                    label={t('suggested.price_for', { name })}
                    value={picked[name] ?? null}
                    onChange={(v) => setPicked((p) => ({ ...p, [name]: v }))}
                  />
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className={buttonPrimary}
        disabled={pending || chosen.length === 0}
        onClick={async () => {
          if (pending) return;
          setPending(true);
          try {
            const db = getDb();
            const ctx = await ledgerContext(db, String(staff?.id ?? ''));
            for (const [name, price] of chosen)
              await saveNewProduct(db, { name_en: name, price }, ctx);
            toast.push(t('suggested.added', { count: chosen.length }));
            void navigate({ to: '/products' });
          } catch (err) {
            toast.push(
              err instanceof Error && err.message
                ? err.message
                : t('errors.generic'),
              'error',
            );
          } finally {
            setPending(false);
          }
        }}
      >
        {t('suggested.add', { count: chosen.length })}
      </button>
    </div>
  );
}
