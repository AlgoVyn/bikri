import { Link, Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { useToast } from '../components/Toast.tsx';
import {
  addCategory,
  CATEGORY_COLORS,
  CategoryInUseError,
  listCategories,
  moveCategory,
  removeCategory,
  updateCategory,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { tileBg } from './tiles.ts';

const textField =
  'h-11 min-w-0 flex-1 rounded-control border border-border-strong bg-surface px-3 text-body text-text';

/** Categories (screens/08): add, rename, colour, reorder, delete when empty. */
export function CategoriesPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const { can } = useCurrentStaff();
  const readOnly = useReadOnly();
  const categories = useLiveQuery(() => listCategories(getDb()), []);
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  if (!can('catalog.edit') || readOnly)
    return <Navigate to="/products" replace />;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-h1 font-semibold">
          {t('categories.title')}
        </h1>
        <Link to="/products" className={buttonQuiet}>
          {t('import.back_to_products')}
        </Link>
      </div>
      <form
        className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3 sm:flex-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await addCategory(
            getDb(),
            name,
            CATEGORY_COLORS[(categories?.length ?? 0) % CATEGORY_COLORS.length],
            {},
            nameUr,
          );
          setName('');
          setNameUr('');
        }}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className="sr-only" htmlFor="new-category">
            {t('categories.new')}
          </label>
          <input
            id="new-category"
            className={textField}
            placeholder={t('categories.new')}
            maxLength={40}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className={textField}
            placeholder={t('categories.name_ur')}
            aria-label={t('categories.name_ur')}
            lang="ur"
            dir="rtl"
            maxLength={40}
            value={nameUr}
            onChange={(e) => setNameUr(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className={`${buttonPrimary} sm:self-start`}
          disabled={!name.trim()}
        >
          {t('form.add')}
        </button>
      </form>
      {categories && categories.length === 0 ? (
        <p className="rounded-card border border-dashed border-border-strong px-4 py-8 text-center text-text-muted">
          {t('categories.empty')}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {categories?.map((c, i) => {
          const label = String(c.name_en);
          return (
            <li
              key={c.id}
              className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3"
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-6 shrink-0 rounded-full ${tileBg(c.color)}`}
                />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <input
                    aria-label={t('categories.name', { name: label })}
                    className={textField}
                    maxLength={40}
                    defaultValue={label}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next && next !== label)
                        void updateCategory(getDb(), c.id, { name_en: next });
                      else e.target.value = label;
                    }}
                  />
                  <input
                    aria-label={t('categories.name_ur')}
                    className={textField}
                    lang="ur"
                    dir="rtl"
                    maxLength={40}
                    placeholder={t('categories.name_ur')}
                    defaultValue={String(c.name_ur ?? '')}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next !== String(c.name_ur ?? ''))
                        void updateCategory(getDb(), c.id, { name_ur: next });
                    }}
                  />
                </span>
                <span className="shrink-0 self-start text-small text-text-muted">
                  {t('categories.products', { count: c.productCount })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <fieldset className="flex flex-wrap gap-1">
                  <legend className="sr-only">
                    {t('categories.color', { name: label })}
                  </legend>
                  {CATEGORY_COLORS.map((color, n) => (
                    <label
                      key={color}
                      className="flex size-11 cursor-pointer items-center justify-center"
                    >
                      <input
                        type="radio"
                        name={`color-${c.id}`}
                        className="peer sr-only"
                        checked={c.color === color}
                        onChange={() =>
                          void updateCategory(getDb(), c.id, { color })
                        }
                      />
                      <span className="sr-only">
                        {t('categories.color_n', { n: n + 1 })}
                      </span>
                      <span
                        aria-hidden="true"
                        className={`size-7 rounded-full ${tileBg(color)} peer-checked:ring-2 peer-checked:ring-text peer-checked:ring-offset-2 peer-focus-visible:outline-2`}
                      />
                    </label>
                  ))}
                </fieldset>
                <div className="ms-auto flex gap-1">
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={i === 0}
                    aria-label={t('categories.up', { name: label })}
                    onClick={() => void moveCategory(getDb(), c.id, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    disabled={i === categories.length - 1}
                    aria-label={t('categories.down', { name: label })}
                    onClick={() => void moveCategory(getDb(), c.id, 1)}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={buttonQuiet}
                    aria-label={t('categories.delete', { name: label })}
                    onClick={async () => {
                      try {
                        await removeCategory(getDb(), c.id);
                      } catch (error) {
                        if (error instanceof CategoryInUseError) {
                          toast.push(
                            t('categories.in_use', { count: error.count }),
                            'error',
                          );
                        } else throw error;
                      }
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
