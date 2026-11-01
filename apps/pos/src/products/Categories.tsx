import { Navigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buttonPrimary,
  buttonQuiet,
  pageClass,
} from '../components/classes.ts';
import { ProductsIcon, TagIcon } from '../components/icons.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { TaskAside, TaskLayout } from '../components/TaskLayout.tsx';
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
  const { can, staff } = useCurrentStaff();
  const readOnly = useReadOnly();
  const categories = useLiveQuery(() => listCategories(getDb()), []);
  const [name, setName] = useState('');
  const [nameUr, setNameUr] = useState('');
  if (!can('catalog.edit') || readOnly)
    return <Navigate to="/products" replace />;

  return (
    <div className={pageClass('standard', 'gap-4')}>
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<ProductsIcon />}
        title={t('categories.title')}
      />
      <TaskLayout
        aside={
          <TaskAside
            title={t('categories.help_title')}
            items={[t('categories.help_1'), t('categories.help_2')]}
          />
        }
      >
        <form
          className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3 sm:flex-row"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            await addCategory(
              getDb(),
              name,
              CATEGORY_COLORS[
                (categories?.length ?? 0) % CATEGORY_COLORS.length
              ],
              { actor: staff?.id ?? null },
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
            className={`${buttonPrimary} sm:self-end`}
            disabled={!name.trim()}
          >
            {t('form.add')}
          </button>
        </form>
        {categories && categories.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-10 text-center shadow-card">
            <span className="flex size-12 items-center justify-center rounded-full bg-primary-subtle text-primary-subtle-ink">
              <TagIcon />
            </span>
            <div>
              <p className="font-medium">{t('categories.empty')}</p>
              <p className="mt-1 text-small text-text-muted">
                {t('categories.empty_hint')}
              </p>
            </div>
          </div>
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
                          void updateCategory(
                            getDb(),
                            c.id,
                            { name_en: next },
                            {
                              actor: staff?.id ?? null,
                            },
                          );
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
                          void updateCategory(
                            getDb(),
                            c.id,
                            { name_ur: next },
                            {
                              actor: staff?.id ?? null,
                            },
                          );
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
                            void updateCategory(
                              getDb(),
                              c.id,
                              { color },
                              {
                                actor: staff?.id ?? null,
                              },
                            )
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
                      onClick={() =>
                        void moveCategory(getDb(), c.id, -1, {
                          actor: staff?.id ?? null,
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      disabled={i === categories.length - 1}
                      aria-label={t('categories.down', { name: label })}
                      onClick={() =>
                        void moveCategory(getDb(), c.id, 1, {
                          actor: staff?.id ?? null,
                        })
                      }
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={buttonQuiet}
                      aria-label={t('categories.delete', { name: label })}
                      onClick={async () => {
                        try {
                          await removeCategory(getDb(), c.id, {
                            actor: staff?.id ?? null,
                          });
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
      </TaskLayout>
    </div>
  );
}
