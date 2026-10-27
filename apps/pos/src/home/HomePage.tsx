import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { EmptyState } from '../components/EmptyState.tsx';
import { ProductsIcon } from '../components/icons.tsx';
import { getDb } from '../data/db.ts';
import { useSession } from '../state/session.ts';

/** Home (screens/04). T-012 adds the first-run empty state; the full Home is T-013. */
export function HomePage() {
  const justSetUp = useSession((s) => s.justSetUp);
  const setJustSetUp = useSession((s) => s.setJustSetUp);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const products = useLiveQuery(
    () =>
      getDb()
        .products.filter((p) => !p.deleted_at)
        .count(),
    [],
  );
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-h1 font-semibold">{t('nav.home')}</h1>
      {justSetUp ? (
        <section
          className="rounded-card border border-border bg-surface p-4"
          aria-labelledby="ready-heading"
        >
          <h2 id="ready-heading" className="text-h2 font-semibold">
            {t('setup.ready')}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonPrimary}
              onClick={() => {
                setJustSetUp(false);
                void navigate({ to: '/sell' });
              }}
            >
              {t('setup.start_selling')}
            </button>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => {
                setJustSetUp(false);
                void navigate({ to: '/settings' });
              }}
            >
              {t('setup.setup_printer')}
            </button>
          </div>
        </section>
      ) : null}
      {products === 0 ? (
        <EmptyState
          icon={<ProductsIcon />}
          message={t('home.no_products')}
          actionLabel={t('home.first_product')}
          onAction={() => void navigate({ to: '/products' })}
        />
      ) : null}
    </div>
  );
}
