import { QTY_UNITS, type QtyUnit } from '@bikri/core';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
} from '../components/classes.ts';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import {
  addCategory,
  barcodeOwner,
  DuplicateBarcodeError,
  DuplicateSkuError,
  duplicateDraft,
  generateBarcode,
  ledgerContext,
  listCategories,
  type ProductInput,
  saveNewProduct,
  saveProductEdit,
  skuTaken,
  uniqueSku,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useFileUrl } from './ProductThumb.tsx';
import { type Photo, PhotoError, processPhoto } from './photo.ts';

const WARRANTY_PRESETS = ['0', '7', '30', '90', '180', '365'] as const;
const textField =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-body text-text outline-none';

type Draft = {
  name_en: string;
  name_ur: string;
  category_id: string;
  brand: string;
  barcodes: string[];
  sku: string;
  price: number | null;
  cost: number | null;
  opening: number | null;
  unit: QtyUnit;
  track_stock: boolean;
  min_stock: number | null;
  warranty: string;
  warranty_days: string;
  notes: string;
  /** New photo; null = removed; undefined = unchanged. */
  photo?: Photo | null;
};

type Errors = Partial<
  Record<'name_en' | 'price' | 'sku' | 'warranty_days', string>
> & { barcodes?: Record<number, string> };

const EMPTY: Draft = {
  name_en: '',
  name_ur: '',
  category_id: '',
  brand: '',
  barcodes: [''],
  sku: '',
  price: null,
  cost: null,
  opening: null,
  unit: 'pc',
  track_stock: true,
  min_stock: null,
  warranty: '0',
  warranty_days: '',
  notes: '',
};

function draftFrom(input: ProductInput): Draft {
  const days = String(input.warranty_days ?? 0);
  const preset = (WARRANTY_PRESETS as readonly string[]).includes(days);
  return {
    name_en: input.name_en,
    name_ur: input.name_ur ?? '',
    category_id: input.category_id ?? '',
    brand: input.brand ?? '',
    barcodes:
      input.barcodes && input.barcodes.length > 0 ? input.barcodes : [''],
    sku: input.sku ?? '',
    price: input.price,
    cost: input.cost ?? null,
    opening: null,
    unit: (QTY_UNITS as readonly string[]).includes(String(input.unit))
      ? (input.unit as QtyUnit)
      : 'pc',
    track_stock: input.track_stock !== false,
    min_stock: input.min_stock_milli ? input.min_stock_milli : null,
    warranty: preset ? days : 'custom',
    warranty_days: preset ? '' : days,
    notes: input.notes ?? '',
  };
}

/** Add / edit product (screens/08). `duplicateOf` pre-fills a copy (AC 7). */
export function ProductFormPage({
  editId,
  duplicateOf,
  barcode,
}: {
  editId?: string;
  duplicateOf?: string;
  /** Pre-filled from Sell's "No product with barcode …" toast (screens/05). */
  barcode?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const formId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft | null>(
    editId || duplicateOf
      ? null
      : barcode
        ? { ...EMPTY, barcodes: [barcode] }
        : EMPTY,
  );
  const [initial, setInitial] = useState<Draft>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [confirmFree, setConfirmFree] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingAnother = useRef(false);
  const [existingKey, setExistingKey] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const existingUrl = useFileUrl(existingKey);
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const brands =
    useLiveQuery(async () => {
      const all = await getDb().products.toArray();
      return [
        ...new Set(
          all
            .filter((p) => !p.deleted_at && p.brand)
            .map((p) => String(p.brand)),
        ),
      ].sort();
    }, []) ?? [];
  const sameName = useLiveQuery(async () => {
    const name = draft?.name_en.trim().toLowerCase();
    if (!name) return false;
    const all = await getDb().products.toArray();
    return all.some(
      (p) =>
        !p.deleted_at &&
        p.id !== editId &&
        String(p.name_en).toLowerCase() === name,
    );
  }, [draft?.name_en, editId]);
  const showCost = can('cost.view');
  const isEdit = editId !== undefined;

  useEffect(() => {
    const sourceId = editId ?? duplicateOf;
    if (!sourceId) return;
    void (async () => {
      const db = getDb();
      const p = await db.products.get(sourceId);
      if (!p || p.deleted_at) {
        setDraft(EMPTY);
        return;
      }
      const base = duplicateDraft(p);
      if (editId) {
        const codes = (
          await db.product_barcodes.where('product_id').equals(editId).toArray()
        )
          .filter((b) => !b.deleted_at)
          .map((b) => String(b.barcode));
        base.sku = String(p.sku);
        base.barcodes = codes;
        setExistingKey(typeof p.image_key === 'string' ? p.image_key : null);
      }
      const loaded = draftFrom(base);
      setDraft(loaded);
      setInitial(loaded);
      setTimeout(() => {
        nameRef.current?.focus();
        if (duplicateOf) nameRef.current?.select();
      }, 0);
    })();
  }, [editId, duplicateOf]);

  useEffect(() => {
    if (!can('catalog.edit')) {
      toast.push(t('shell.no_access'), 'error');
      void navigate({ to: '/products', replace: true });
    }
  }, [can, navigate, t, toast]);

  const dirty =
    draft !== null &&
    JSON.stringify(draft) !==
      JSON.stringify(isEdit || duplicateOf ? initial : EMPTY);
  const leave = () =>
    editId
      ? void navigate({ to: '/products/$id', params: { id: editId } })
      : void navigate({ to: '/products' });

  useHotkey(
    (e) => (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's',
    (e) => void submit(e.shiftKey && !isEdit),
    { inFields: true, enabled: draft !== null },
  );
  useHotkey(
    (e) => e.key === 'Escape',
    () => (dirty ? setConfirmDiscard(true) : leave()),
    {
      inFields: true,
      enabled: draft !== null && !confirmFree && !confirmDiscard,
    },
  );

  if (draft === null) return null;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const warrantyDays = () =>
    draft.warranty === 'custom'
      ? Number(draft.warranty_days)
      : Number(draft.warranty);

  async function validate(d: Draft): Promise<Errors> {
    const db = getDb();
    const next: Errors = {};
    const name = d.name_en.trim();
    if (name.length < 1 || name.length > 80)
      next.name_en = t('form.name_required');
    if (d.price === null) next.price = t('form.price_required');
    if (d.warranty === 'custom') {
      const days = Number(d.warranty_days);
      if (!Number.isInteger(days) || days < 1 || days > 3650)
        next.warranty_days = t('form.warranty_invalid');
    }
    const seen = new Map<string, number>();
    const barcodeErrors: Record<number, string> = {};
    for (const [i, raw] of d.barcodes.entries()) {
      const code = raw.trim();
      if (!code) continue;
      if (code.length < 3 || code.length > 64)
        barcodeErrors[i] = t('form.barcode_length');
      else if (seen.has(code)) barcodeErrors[i] = t('form.barcode_repeat');
      else {
        const owner = await barcodeOwner(db, code, editId);
        if (owner)
          barcodeErrors[i] = t('form.barcode_taken', {
            name: String(owner.name_en),
          });
      }
      seen.set(code, i);
    }
    if (Object.keys(barcodeErrors).length > 0) next.barcodes = barcodeErrors;
    if (d.sku.trim() && (await skuTaken(db, d.sku, editId)))
      next.sku = t('form.sku_taken');
    return next;
  }

  function focusFirstError(e: Errors) {
    const order: string[] = [
      'name_en',
      ...(e.barcodes ? [`barcode-${Object.keys(e.barcodes)[0]}`] : []),
      'sku',
      'price',
      'warranty_days',
    ];
    for (const key of order) {
      if (key === 'name_en' && !e.name_en) continue;
      if (key === 'sku' && !e.sku) continue;
      if (key === 'price' && !e.price) continue;
      if (key === 'warranty_days' && !e.warranty_days) continue;
      document.getElementById(`${formId}-${key}`)?.focus();
      return;
    }
  }

  async function submit(another: boolean, freeConfirmed = false) {
    if (saving || !draft) return;
    const found = await validate(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      focusFirstError(found);
      return;
    }
    if (draft.price === 0 && !freeConfirmed) {
      setConfirmFree(true);
      pendingAnother.current = another;
      return;
    }
    setSaving(true);
    try {
      const db = getDb();
      const ctx = await ledgerContext(db, String(staff?.id ?? ''));
      const input: ProductInput = {
        name_en: draft.name_en,
        name_ur: draft.name_ur,
        brand: draft.brand,
        category_id: draft.category_id || null,
        sku: draft.sku,
        barcodes: draft.barcodes.map((b) => b.trim()).filter(Boolean),
        unit: draft.unit,
        price: draft.price ?? 0,
        cost: showCost ? (draft.cost ?? 0) : undefined,
        track_stock: draft.track_stock,
        min_stock_milli: draft.track_stock ? (draft.min_stock ?? 0) : 0,
        warranty_days: warrantyDays(),
        notes: draft.notes,
        photo: draft.photo,
        opening_milli: draft.track_stock ? (draft.opening ?? 0) : 0,
      };
      if (!showCost && !isEdit) input.cost = 0;
      const saved = isEdit
        ? await saveProductEdit(db, editId, input, ctx)
        : await saveNewProduct(db, input, ctx);
      toast.push(t('form.saved'));
      if (another) {
        setPhotoUrl(null);
        setDraft(EMPTY);
        setErrors({});
        void navigate({ to: '/products/new', search: {} });
        setTimeout(() => nameRef.current?.focus(), 0);
      } else {
        void navigate({ to: '/products/$id', params: { id: saved.id } });
      }
    } catch (error) {
      if (error instanceof DuplicateBarcodeError)
        setErrors({
          barcodes: { 0: t('form.barcode_taken', { name: error.ownerName }) },
        });
      else if (error instanceof DuplicateSkuError)
        setErrors({ sku: t('form.sku_taken') });
      else throw error;
    } finally {
      setSaving(false);
    }
  }

  const fieldId = (key: string) => `${formId}-${key}`;
  const errorText = (key: string, text?: string) =>
    text ? (
      <p id={`${fieldId(key)}-error`} className="mt-1 text-small text-danger">
        {text}
      </p>
    ) : null;

  return (
    <form
      className="mx-auto flex max-w-2xl flex-col gap-4 p-4 pb-28"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <h1 className="text-h1 font-semibold">
        {isEdit ? t('form.edit_title') : t('form.new_title')}
      </h1>

      <fieldset className="flex flex-wrap items-center gap-3">
        <legend className="mb-1 text-small">{t('form.photo')}</legend>
        {(draft.photo === undefined ? existingUrl : photoUrl) ? (
          <img
            src={(draft.photo === undefined ? existingUrl : photoUrl) ?? ''}
            alt={t('form.photo_preview')}
            data-testid="form-photo"
            className="size-20 rounded-card object-cover"
          />
        ) : (
          <span
            aria-hidden="true"
            className="size-20 rounded-card border border-dashed border-border-strong"
          />
        )}
        <label
          className={`${buttonQuiet} cursor-pointer focus-within:outline-2`}
        >
          {t('form.photo_pick')}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            aria-describedby={
              photoError ? `${fieldId('photo')}-error` : undefined
            }
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const photo = await processPhoto(file);
                setPhotoError(false);
                if (photoUrl) URL.revokeObjectURL(photoUrl);
                setPhotoUrl(URL.createObjectURL(photo.blob));
                set('photo', photo);
              } catch (error) {
                if (error instanceof PhotoError) setPhotoError(true);
                else throw error;
              }
            }}
          />
        </label>
        {(draft.photo === undefined && existingKey) || draft.photo ? (
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => {
              set('photo', existingKey ? null : undefined);
              setPhotoUrl(null);
            }}
          >
            {t('form.photo_remove')}
          </button>
        ) : null}
        {photoError ? (
          <p
            id={`${fieldId('photo')}-error`}
            className="w-full text-small text-danger"
          >
            {t('form.photo_error')}
          </p>
        ) : null}
      </fieldset>

      <div>
        <label htmlFor={fieldId('name_en')} className="mb-1 block text-small">
          {t('form.name_en')}
        </label>
        <input
          ref={nameRef}
          id={fieldId('name_en')}
          className={textField}
          maxLength={80}
          value={draft.name_en}
          aria-invalid={errors.name_en ? true : undefined}
          aria-describedby={
            errors.name_en
              ? `${fieldId('name_en')}-error`
              : sameName
                ? `${fieldId('name_en')}-warn`
                : undefined
          }
          onChange={(e) => set('name_en', e.target.value)}
        />
        {errorText('name_en', errors.name_en)}
        {!errors.name_en && sameName ? (
          <p
            id={`${fieldId('name_en')}-warn`}
            className="mt-1 text-small text-warning"
          >
            {t('form.name_duplicate')}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={fieldId('name_ur')} className="mb-1 block text-small">
          {t('form.name_ur')}
        </label>
        <input
          id={fieldId('name_ur')}
          dir="rtl"
          lang="ur"
          className={`${textField} font-urdu`}
          maxLength={80}
          value={draft.name_ur}
          onChange={(e) => set('name_ur', e.target.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor={fieldId('category')}
            className="mb-1 block text-small"
          >
            {t('form.category')}
          </label>
          <div className="flex gap-2">
            <select
              id={fieldId('category')}
              className={`${textField} min-w-0`}
              value={draft.category_id}
              onChange={(e) => set('category_id', e.target.value)}
            >
              <option value="">{t('form.no_category')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {String(c.name_en)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={buttonQuiet}
              onClick={() => setNewCategory('')}
            >
              {t('form.new_category')}
            </button>
          </div>
          {newCategory !== null ? (
            <div className="mt-2 flex gap-2">
              <label className="sr-only" htmlFor={fieldId('new-category')}>
                {t('form.new_category_name')}
              </label>
              <input
                id={fieldId('new-category')}
                className={textField}
                placeholder={t('form.new_category_name')}
                maxLength={40}
                // biome-ignore lint/a11y/noAutofocus: opened by the user's own click
                autoFocus
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (
                      e.currentTarget
                        .nextElementSibling as HTMLButtonElement | null
                    )?.click();
                  }
                }}
              />
              <button
                type="button"
                className={buttonQuiet}
                disabled={!newCategory.trim()}
                onClick={async () => {
                  const created = await addCategory(getDb(), newCategory);
                  set('category_id', created.id);
                  setNewCategory(null);
                }}
              >
                {t('form.add')}
              </button>
            </div>
          ) : null}
        </div>
        <div>
          <label htmlFor={fieldId('brand')} className="mb-1 block text-small">
            {t('form.brand')}
          </label>
          <input
            id={fieldId('brand')}
            className={textField}
            maxLength={40}
            list={fieldId('brands')}
            value={draft.brand}
            onChange={(e) => set('brand', e.target.value)}
          />
          <datalist id={fieldId('brands')}>
            {brands.map((b) => (
              <option key={b} value={b} />
            ))}
          </datalist>
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-small">{t('products.barcodes')}</legend>
        {draft.barcodes.map((code, i) => {
          const key = `barcode-${i}`;
          const err = errors.barcodes?.[i];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: barcode rows have no id until saved
            <div key={i}>
              <div className="flex gap-2">
                <label className="sr-only" htmlFor={fieldId(key)}>
                  {t('form.barcode', { n: i + 1 })}
                </label>
                <input
                  id={fieldId(key)}
                  dir="ltr"
                  inputMode="numeric"
                  className={fieldClass}
                  maxLength={64}
                  value={code}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${fieldId(key)}-error` : undefined}
                  onChange={(e) =>
                    set(
                      'barcodes',
                      draft.barcodes.map((b, j) =>
                        j === i ? e.target.value : b,
                      ),
                    )
                  }
                />
                {draft.barcodes.length > 1 ? (
                  <button
                    type="button"
                    className={buttonQuiet}
                    aria-label={t('form.remove_barcode', { n: i + 1 })}
                    onClick={() =>
                      set(
                        'barcodes',
                        draft.barcodes.filter((_, j) => j !== i),
                      )
                    }
                  >
                    ×
                  </button>
                ) : null}
              </div>
              {errorText(key, err)}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={buttonQuiet}
            onClick={() => set('barcodes', [...draft.barcodes, ''])}
          >
            {t('form.add_barcode')}
          </button>
          <button
            type="button"
            className={buttonQuiet}
            onClick={async () => {
              const code = await generateBarcode(getDb());
              const list = [...draft.barcodes];
              const empty = list.findIndex((b) => !b.trim());
              if (empty >= 0) list[empty] = code;
              else list.push(code);
              set('barcodes', list);
            }}
          >
            {t('form.generate_barcode')}
          </button>
        </div>
      </fieldset>

      <div>
        <label htmlFor={fieldId('sku')} className="mb-1 block text-small">
          {t('form.sku')}
        </label>
        <div className="flex gap-2">
          <input
            id={fieldId('sku')}
            dir="ltr"
            className={fieldClass}
            maxLength={40}
            value={draft.sku}
            aria-invalid={errors.sku ? true : undefined}
            aria-describedby={
              errors.sku ? `${fieldId('sku')}-error` : `${fieldId('sku')}-hint`
            }
            onChange={(e) => set('sku', e.target.value)}
          />
          <button
            type="button"
            className={buttonQuiet}
            onClick={async () =>
              set('sku', await uniqueSku(getDb(), draft.name_en || 'item'))
            }
          >
            {t('form.generate_sku')}
          </button>
        </div>
        {errors.sku ? (
          errorText('sku', errors.sku)
        ) : (
          <p
            id={`${fieldId('sku')}-hint`}
            className="mt-1 text-small text-text-muted"
          >
            {t('form.sku_hint')}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <MoneyInput
            id={fieldId('price')}
            label={t('form.price')}
            value={draft.price}
            onChange={(v) => set('price', v)}
          />
          {errorText('price', errors.price)}
        </div>
        {showCost ? (
          <div>
            <MoneyInput
              id={fieldId('cost')}
              label={t('form.cost')}
              value={draft.cost}
              onChange={(v) => set('cost', v)}
            />
            {isEdit ? (
              <p className="mt-1 text-small text-text-muted">
                {t('form.cost_edit_hint')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor={fieldId('unit')} className="mb-1 block text-small">
            {t('form.unit')}
          </label>
          <select
            id={fieldId('unit')}
            className={textField}
            value={draft.unit}
            onChange={(e) => set('unit', e.target.value as QtyUnit)}
          >
            {QTY_UNITS.map((u) => (
              <option key={u} value={u}>
                {t(`unit.${u}`)}
              </option>
            ))}
          </select>
        </div>
        <label className="flex min-h-11 items-center gap-3 self-end">
          <input
            type="checkbox"
            role="switch"
            aria-checked={draft.track_stock}
            className="size-5"
            checked={draft.track_stock}
            onChange={(e) => set('track_stock', e.target.checked)}
          />
          {t('form.track_stock')}
        </label>
      </div>

      {draft.track_stock ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {isEdit ? null : (
            <QtyInput
              id={fieldId('opening')}
              label={t('form.opening')}
              unit={draft.unit}
              value={draft.opening}
              onChange={(v) => set('opening', v)}
            />
          )}
          <QtyInput
            id={fieldId('min')}
            label={t('form.min_stock')}
            unit={draft.unit}
            value={draft.min_stock}
            onChange={(v) => set('min_stock', v)}
          />
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label
            htmlFor={fieldId('warranty')}
            className="mb-1 block text-small"
          >
            {t('form.warranty')}
          </label>
          <select
            id={fieldId('warranty')}
            className={textField}
            value={draft.warranty}
            onChange={(e) => set('warranty', e.target.value)}
          >
            <option value="0">{t('form.warranty_none')}</option>
            <option value="7">{t('form.warranty_7')}</option>
            <option value="30">{t('form.warranty_30')}</option>
            <option value="90">{t('form.warranty_90')}</option>
            <option value="180">{t('form.warranty_180')}</option>
            <option value="365">{t('form.warranty_365')}</option>
            <option value="custom">{t('form.warranty_custom')}</option>
          </select>
        </div>
        {draft.warranty === 'custom' ? (
          <div>
            <label
              htmlFor={fieldId('warranty_days')}
              className="mb-1 block text-small"
            >
              {t('form.warranty_days')}
            </label>
            <input
              id={fieldId('warranty_days')}
              inputMode="numeric"
              dir="ltr"
              className={fieldClass}
              value={draft.warranty_days}
              aria-invalid={errors.warranty_days ? true : undefined}
              aria-describedby={
                errors.warranty_days
                  ? `${fieldId('warranty_days')}-error`
                  : undefined
              }
              onChange={(e) =>
                set('warranty_days', e.target.value.replace(/\D/gu, ''))
              }
            />
            {errorText('warranty_days', errors.warranty_days)}
          </div>
        ) : null}
      </div>

      <div>
        <label htmlFor={fieldId('notes')} className="mb-1 block text-small">
          {t('form.notes')}
        </label>
        <textarea
          id={fieldId('notes')}
          className="min-h-20 w-full rounded-control border border-border-strong bg-surface p-3 text-body text-text"
          maxLength={500}
          value={draft.notes}
          onChange={(e) => set('notes', e.target.value)}
        />
      </div>

      <div className="fixed inset-x-0 bottom-tabbar z-20 flex flex-wrap justify-end gap-2 border-t border-border bg-surface px-4 py-2 lg:bottom-0 lg:start-rail">
        <button
          type="button"
          className={`${buttonQuiet} gap-2`}
          onClick={() => (dirty ? setConfirmDiscard(true) : leave())}
        >
          {t('common.cancel')}
        </button>
        {isEdit ? null : (
          <button
            type="button"
            className={`${buttonQuiet} gap-2`}
            disabled={saving}
            onClick={() => void submit(true)}
          >
            {t('form.save_another')}
            <span className="max-lg:hidden"></span>
          </button>
        )}
        <button
          type="submit"
          className={`${buttonPrimary} gap-2`}
          disabled={saving}
        >
          {t('form.save')}
          <span className="max-lg:hidden"></span>
        </button>
      </div>

      <ConfirmDialog
        open={confirmFree}
        onOpenChange={setConfirmFree}
        title={t('form.free_title')}
        body={t('form.free_body')}
        confirmLabel={t('form.free_confirm')}
        onConfirm={() => {
          setConfirmFree(false);
          void submit(pendingAnother.current, true);
        }}
      />
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title={t('form.discard_title')}
        body={t('form.discard_body')}
        confirmLabel={t('form.discard')}
        onConfirm={() => {
          setConfirmDiscard(false);
          leave();
        }}
      />
    </form>
  );
}
