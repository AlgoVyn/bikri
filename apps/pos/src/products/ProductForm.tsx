import { priceBundle, QTY_UNITS, type QtyUnit } from '@bikri/core';
import type { MasterRow } from '@bikri/db';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import {
  buttonPrimary,
  buttonQuiet,
  fieldClass,
  monoFieldClass,
  pageClass,
  textareaClass,
} from '../components/classes.ts';
import { CloseIcon, ProductsIcon } from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
import { useToast } from '../components/Toast.tsx';
import { shopMoney } from '../data/cart.ts';
import {
  addCategory,
  type BundleItemInput,
  BundleRecipeError,
  barcodeOwner,
  ComponentInUseError,
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
  TrackedCostError,
  uniqueSku,
} from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { categoryName } from '../lib/category.ts';
import { useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
import { qtyWithUnit } from './format.ts';
import { useFileUrl } from './ProductThumb.tsx';
import { type Photo, PhotoError, processPhoto } from './photo.ts';

const WARRANTY_PRESETS = ['0', '7', '30', '90', '180', '365'] as const;

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
  kind: 'simple' | 'bundle';
  bundle_items: BundleItemInput[];
  /** New photo; null = removed; undefined = unchanged. */
  photo?: Photo | null;
};

type Errors = Partial<
  Record<'name_en' | 'price' | 'sku' | 'warranty_days' | 'bundle', string>
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
  kind: 'simple',
  bundle_items: [],
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
    kind: input.kind === 'bundle' ? 'bundle' : 'simple',
    bundle_items: input.bundle_items ?? [],
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
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const readOnly = useReadOnly();
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
  const [confirmUntrack, setConfirmUntrack] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingAnother = useRef(false);
  const pendingFreeConfirmed = useRef(false);
  const untrackDialogConfirmed = useRef(false);
  const pendingSave = useRef(false);
  const [existingKey, setExistingKey] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const existingUrl = useFileUrl(existingKey);
  const categories = useLiveQuery(() => listCategories(getDb()), []) ?? [];
  const shop = useLiveQuery(() => getDb().shop.get('shop'), []);
  const money = shopMoney(shop);
  // One read of the catalogue powers the bundle picker, the brand suggestions and
  // the duplicate-name check; the form used to read products twice and levels once
  // more (D-231).
  const catalogue = useLiveQuery(async () => {
    const db = getDb();
    const all = await db.products.toArray();
    const levels = new Map(
      (await db.stock_levels.toArray()).map((level) => [
        level.product_id,
        level.on_hand_milli,
      ]),
    );
    const simple = all.filter(
      (product) =>
        !product.deleted_at &&
        product.kind !== 'bundle' &&
        product.id !== editId,
    );
    const brands = new Set<string>();
    const names = new Map<string, string>();
    for (const product of all) {
      if (product.deleted_at) continue;
      const name = String(product.name_en ?? '')
        .trim()
        .toLowerCase();
      if (name) names.set(name, product.id);
      const brand = String(product.brand ?? '').trim();
      if (brand) brands.add(brand);
    }
    return {
      all: simple,
      levels,
      brands: [...brands].sort((a, b) => a.localeCompare(b)),
      names,
    };
  }, [editId]) ?? {
    all: [],
    levels: new Map<string, number>(),
    brands: [] as string[],
    names: new Map<string, string>(),
  };
  const onHand =
    useLiveQuery(async () => {
      if (!editId) return 0;
      return (await getDb().stock_levels.get(editId))?.on_hand_milli ?? 0;
    }, [editId]) ?? 0;
  const brands = catalogue.brands;
  const draftName = String(draft?.name_en ?? '')
    .trim()
    .toLowerCase();
  const sameName =
    draftName !== '' &&
    catalogue.names.has(draftName) &&
    catalogue.names.get(draftName) !== editId;
  const showCost = can('cost.view');
  const isEdit = editId !== undefined;
  const backId = editId ?? duplicateOf;
  const wantsUntrack =
    isEdit && initial.track_stock && draft?.track_stock === false;
  const onHandQty = qtyWithUnit(t, onHand, draft?.unit ?? 'pc');
  const isBundleDraft = draft?.kind === 'bundle';
  // A tracked product's cost is maintained by deliveries and stock movements.
  const costLocked =
    isEdit &&
    !isBundleDraft &&
    Boolean(initial.track_stock) &&
    Boolean(draft?.track_stock);

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
      if (p.kind === 'bundle') {
        base.kind = 'bundle';
        base.bundle_items = (
          await db.bundle_items.where('bundle_id').equals(p.id).toArray()
        )
          .filter((row) => !row.deleted_at)
          .sort((a, b) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
          .map((row) => ({
            component_product_id: String(row.component_product_id),
            qty_milli: Number(row.qty_milli),
          }));
      }
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
    backId
      ? void navigate({ to: '/products/$id', params: { id: backId } })
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
      enabled:
        draft !== null && !confirmFree && !confirmDiscard && !confirmUntrack,
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
    if (d.kind === 'bundle') {
      const valid =
        d.bundle_items.length >= 1 &&
        d.bundle_items.length <= 20 &&
        d.bundle_items.every(
          (item) =>
            item.component_product_id !== editId &&
            Number.isSafeInteger(item.qty_milli) &&
            item.qty_milli > 0,
        );
      if (!valid) next.bundle = t('form.bundle_items_required');
    }
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
      'bundle',
      'warranty_days',
    ];
    for (const key of order) {
      if (key === 'name_en' && !e.name_en) continue;
      if (key === 'sku' && !e.sku) continue;
      if (key === 'price' && !e.price) continue;
      if (key === 'bundle' && !e.bundle) continue;
      if (key === 'warranty_days' && !e.warranty_days) continue;
      document.getElementById(`${formId}-${key}`)?.focus();
      return;
    }
  }

  async function submit(
    another: boolean,
    freeConfirmed = false,
    untrackConfirmed = false,
  ) {
    if (pendingSave.current || !draft) return;
    // Set synchronously: a double click must not start a second product (two ids).
    pendingSave.current = true;
    setSaving(true);
    try {
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
      if (wantsUntrack && !untrackConfirmed) {
        setConfirmUntrack(true);
        pendingAnother.current = another;
        pendingFreeConfirmed.current = freeConfirmed;
        return;
      }
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
        cost: showCost && !costLocked ? (draft.cost ?? 0) : undefined,
        track_stock: draft.track_stock,
        min_stock_milli: draft.track_stock ? (draft.min_stock ?? 0) : 0,
        warranty_days: warrantyDays(),
        notes: draft.notes,
        photo: draft.photo,
        opening_milli:
          draft.kind === 'bundle' || !draft.track_stock
            ? 0
            : (draft.opening ?? 0),
        kind: draft.kind,
        ...(draft.kind === 'bundle'
          ? { bundle_items: draft.bundle_items }
          : {}),
      };
      if (!showCost && !isEdit && draft.kind !== 'bundle') input.cost = 0;
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
      else if (error instanceof BundleRecipeError)
        setErrors({ bundle: t(`form.bundle_error_${error.code}`) });
      else if (error instanceof TrackedCostError)
        toast.push(t('form.cost_tracked_hint'), 'error');
      else if (error instanceof ComponentInUseError)
        toast.push(
          t('products.component_in_use', { name: error.bundleName }),
          'error',
        );
      else toast.push(t('errors.generic'), 'error');
    } finally {
      pendingSave.current = false;
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

  if (readOnly) return <Navigate to="/products" replace />;

  return (
    <form
      className={`${pageClass('standard', 'gap-4')} pb-28`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <SubpageHeader
        backTo={backId ? '/products/$id' : '/products'}
        backParams={backId ? { id: backId } : undefined}
        backLabel={t(backId ? 'products.back_to_product' : 'products.back')}
        onBack={() => (dirty ? setConfirmDiscard(true) : leave())}
        icon={<ProductsIcon />}
        title={isEdit ? t('form.edit_title') : t('form.new_title')}
      />

      <div className="grid gap-4 lg:grid-cols-2 lg:items-stretch">
        <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card">
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
            <label
              htmlFor={fieldId('name_en')}
              className="mb-1 block text-small"
            >
              {t('form.name_en')}
            </label>
            <input
              ref={nameRef}
              id={fieldId('name_en')}
              className={fieldClass}
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
            <label
              htmlFor={fieldId('name_ur')}
              className="mb-1 block text-small"
            >
              {t('form.name_ur')}
            </label>
            <input
              id={fieldId('name_ur')}
              dir="rtl"
              lang="ur"
              className={`${fieldClass} font-urdu`}
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
                  className={`${fieldClass} min-w-0 flex-1`}
                  value={draft.category_id}
                  onChange={(e) => set('category_id', e.target.value)}
                >
                  <option value="">{t('form.no_category')}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {categoryName(c, i18n.language)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={`${buttonQuiet} shrink-0 whitespace-nowrap`}
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
                    className={`${fieldClass} min-w-0 flex-1`}
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
                    className={`${buttonQuiet} shrink-0`}
                    disabled={!newCategory.trim()}
                    onClick={async () => {
                      const created = await addCategory(
                        getDb(),
                        newCategory,
                        't1',
                        {
                          actor: staff?.id ?? null,
                        },
                      );
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
              <label
                htmlFor={fieldId('brand')}
                className="mb-1 block text-small"
              >
                {t('form.brand')}
              </label>
              <input
                id={fieldId('brand')}
                className={fieldClass}
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
            <legend className="mb-1 text-small">
              {t('products.barcodes')}
            </legend>
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
                      className={monoFieldClass}
                      maxLength={64}
                      value={code}
                      aria-invalid={err ? true : undefined}
                      aria-describedby={
                        err ? `${fieldId(key)}-error` : undefined
                      }
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
                        onClick={() => {
                          set(
                            'barcodes',
                            draft.barcodes.filter((_, j) => j !== i),
                          );
                          if (errors.barcodes) {
                            const next: Record<number, string> = {};
                            for (const [key, value] of Object.entries(
                              errors.barcodes,
                            )) {
                              const at = Number(key);
                              if (at < i) next[at] = value;
                              else if (at > i) next[at - 1] = value;
                            }
                            setErrors({ ...errors, barcodes: next });
                          }
                        }}
                      >
                        <CloseIcon className="size-5" />
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
                className={monoFieldClass}
                maxLength={40}
                value={draft.sku}
                aria-invalid={errors.sku ? true : undefined}
                aria-describedby={
                  errors.sku
                    ? `${fieldId('sku')}-error`
                    : `${fieldId('sku')}-hint`
                }
                onChange={(e) => set('sku', e.target.value)}
              />
              <button
                type="button"
                className={`${buttonQuiet} shrink-0 whitespace-nowrap`}
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
        </div>

        <div className="flex min-w-0 flex-col gap-4 rounded-card border border-border bg-surface p-4 shadow-card">
          <label className="flex min-h-11 items-center gap-3">
            <input
              id={fieldId('kind')}
              type="checkbox"
              className="size-5"
              checked={isBundleDraft}
              disabled={isEdit && initial.kind === 'bundle'}
              onChange={(e) => {
                if (e.target.checked) {
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          kind: 'bundle',
                          unit: 'set',
                          track_stock: false,
                          opening: null,
                          min_stock: null,
                          cost: null,
                          warranty: '0',
                        }
                      : current,
                  );
                } else {
                  set('kind', 'simple');
                }
              }}
            />
            {t('form.is_bundle')}
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <MoneyInput
                id={fieldId('price')}
                label={t(isBundleDraft ? 'form.bundle_price' : 'form.price')}
                value={draft.price}
                onChange={(v) => set('price', v)}
              />
              {errorText('price', errors.price)}
            </div>
            {showCost && !isBundleDraft ? (
              <div>
                <MoneyInput
                  id={fieldId('cost')}
                  label={t('form.cost')}
                  value={draft.cost}
                  disabled={costLocked}
                  onChange={(v) => set('cost', v)}
                />
                {costLocked ? (
                  <p className="mt-1 text-small text-text-muted">
                    {t('form.cost_tracked_hint')}
                  </p>
                ) : isEdit ? (
                  <p className="mt-1 text-small text-text-muted">
                    {t('form.cost_edit_hint')}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor={fieldId('unit')}
                className="mb-1 block text-small"
              >
                {t('form.unit')}
              </label>
              <select
                id={fieldId('unit')}
                className={fieldClass}
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
            {isBundleDraft ? null : (
              <label className="flex min-h-11 items-center gap-3 self-end">
                <input
                  id={fieldId('track_stock')}
                  type="checkbox"
                  role="switch"
                  aria-checked={draft.track_stock}
                  aria-describedby={
                    wantsUntrack ? `${fieldId('track_stock')}-warn` : undefined
                  }
                  className="size-5"
                  checked={draft.track_stock}
                  onChange={(e) => set('track_stock', e.target.checked)}
                />
                {t('form.track_stock')}
              </label>
            )}
          </div>

          {errors.bundle ? (
            <p className="text-small text-danger">{errors.bundle}</p>
          ) : null}

          {isBundleDraft ? (
            <BundleRecipeEditor
              items={draft.bundle_items}
              onChange={(items) => set('bundle_items', items)}
              products={catalogue.all}
              levels={catalogue.levels}
              price={draft.price ?? 0}
              method={money.cost_method}
              showCost={showCost}
              excludeId={editId}
            />
          ) : null}

          {wantsUntrack && !isBundleDraft ? (
            <p
              id={`${fieldId('track_stock')}-warn`}
              role="status"
              className="rounded-control bg-warning-subtle p-2 text-small text-warning-subtle-ink"
            >
              {t('form.track_off_warn', { qty: onHandQty })}
            </p>
          ) : null}

          {draft.track_stock && !isBundleDraft ? (
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

          {isBundleDraft ? null : (
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
                  className={fieldClass}
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
                    className={monoFieldClass}
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
          )}

          <div>
            <label htmlFor={fieldId('notes')} className="mb-1 block text-small">
              {t('form.notes')}
            </label>
            <textarea
              id={fieldId('notes')}
              className={textareaClass}
              maxLength={500}
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-tabbar z-20 border-t border-border bg-surface px-4 py-2 shadow-topbar lg:bottom-0 lg:start-rail">
        <div className="mx-auto flex w-full max-w-[1152px] flex-wrap justify-end gap-2">
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
      <ConfirmDialog
        open={confirmUntrack}
        onOpenChange={(open) => {
          // Dismissing or "Keep tracking" restores the switch, so the form never
          // stays in the untracked state after a cancelled save.
          if (!open && !untrackDialogConfirmed.current)
            set('track_stock', true);
          untrackDialogConfirmed.current = false;
          setConfirmUntrack(open);
        }}
        title={t('form.track_off_title', { name: draft.name_en })}
        body={t('form.track_off_body', { qty: onHandQty })}
        confirmLabel={t('form.track_off_confirm')}
        cancelLabel={t('form.track_off_keep')}
        onConfirm={() => {
          untrackDialogConfirmed.current = true;
          setConfirmUntrack(false);
          void submit(
            pendingAnother.current,
            pendingFreeConfirmed.current,
            true,
          );
        }}
      />
    </form>
  );
}

/** Fixed recipe editor inside the normal product form (screens/08 bundles). */
function BundleRecipeEditor({
  items,
  onChange,
  products,
  levels,
  price,
  method,
  showCost,
  excludeId,
}: {
  items: BundleItemInput[];
  onChange: (items: BundleItemInput[]) => void;
  products: MasterRow[];
  levels: ReadonlyMap<string, number>;
  price: number;
  method: 'avg' | 'last';
  showCost: boolean;
  excludeId?: string;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState('');
  const byId = new Map(products.map((product) => [product.id, product]));
  const chosen = new Set(items.map((item) => item.component_product_id));
  const q = query.trim().toLowerCase();
  const matches = q
    ? products
        .filter(
          (product) =>
            !chosen.has(product.id) &&
            product.id !== excludeId &&
            [product.name_en, product.name_ur, product.sku]
              .map((value) => String(value ?? '').toLowerCase())
              .some((value) => value.includes(q)),
        )
        .slice(0, 8)
    : [];
  const result =
    items.length > 0
      ? priceBundle({
          bundle_price: price,
          bundle_qty: 1,
          components: items.flatMap((item) => {
            const product = byId.get(item.component_product_id);
            return product
              ? [
                  {
                    qty_milli: item.qty_milli,
                    unit_cost:
                      method === 'last'
                        ? Number(product.last_cost ?? 0)
                        : Number(product.avg_cost ?? 0),
                    unit_price: Number(product.price ?? 0),
                  },
                ]
              : [];
          }),
        })
      : null;
  let available: number | null = null;
  for (const item of items) {
    const product = byId.get(item.component_product_id);
    if (product?.track_stock !== 1) continue;
    const canMake = Math.floor((levels.get(product.id) ?? 0) / item.qty_milli);
    available = available === null ? canMake : Math.min(available, canMake);
  }
  const add = (id: string) => {
    const item = items.find((row) => row.component_product_id === id);
    onChange(
      item
        ? items.map((row) =>
            row.component_product_id === id
              ? { ...row, qty_milli: row.qty_milli + 1000 }
              : row,
          )
        : [...items, { component_product_id: id, qty_milli: 1000 }],
    );
    setQuery('');
  };
  return (
    <fieldset className="flex flex-col gap-2 rounded-control border border-border p-3">
      <legend className="px-1 text-small font-medium">
        {t('form.bundle_items')}
      </legend>
      {items.length === 0 ? (
        <p className="text-small text-text-muted">
          {t('form.bundle_items_empty')}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((item, index) => {
            const product = byId.get(item.component_product_id);
            return (
              <li
                key={item.component_product_id}
                className="flex flex-wrap items-end gap-2 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {product
                      ? i18n.language === 'ur' && product.name_ur
                        ? String(product.name_ur)
                        : String(product.name_en)
                      : item.component_product_id}
                  </p>
                  {product ? (
                    <p className="text-small text-text-muted">
                      <bdi dir="ltr">{String(product.sku)}</bdi> ·{' '}
                      <MoneyText paisa={Number(product.price)} />
                    </p>
                  ) : null}
                </div>
                <div className="w-32">
                  <QtyInput
                    dense
                    label={t('form.bundle_qty')}
                    unit={(product?.unit as QtyUnit | undefined) ?? 'pc'}
                    value={item.qty_milli}
                    onChange={(milli) => {
                      if (milli === null) return;
                      onChange(
                        items.map((row, at) =>
                          at === index
                            ? { ...row, qty_milli: Math.max(1, milli) }
                            : row,
                        ),
                      );
                    }}
                  />
                </div>
                <button
                  type="button"
                  className={buttonQuiet}
                  aria-label={t('form.bundle_remove', {
                    name: product ? String(product.name_en) : '',
                  })}
                  onClick={() =>
                    onChange(items.filter((_, at) => at !== index))
                  }
                >
                  <CloseIcon className="size-5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-small" htmlFor="bundle-add-search">
          {t('form.bundle_add_item')}
        </label>
        <input
          id="bundle-add-search"
          className={fieldClass}
          placeholder={t('form.bundle_search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {matches.length > 0 ? (
          <ul className="flex flex-col rounded-control border border-border">
            {matches.map((product) => (
              <li key={product.id}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-2 px-2 py-2 text-start hover:bg-surface-2"
                  onClick={() => add(product.id)}
                >
                  <span className="min-w-0 truncate">
                    {String(product.name_en)}
                    <span className="ms-2 text-small text-text-muted">
                      <bdi dir="ltr">{String(product.sku)}</bdi>
                    </span>
                  </span>
                  <MoneyText paisa={Number(product.price)} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {result ? (
        <dl className="grid grid-cols-2 gap-2 rounded-control bg-surface-2 p-2 text-small">
          <div>
            <dt className="text-text-muted">{t('products.items_total')}</dt>
            <dd>
              <MoneyText paisa={result.items_total} />
            </dd>
          </div>
          <div>
            <dt className="text-text-muted">{t('products.bundle_saves')}</dt>
            <dd>
              <MoneyText paisa={result.saving} />
            </dd>
          </div>
          {showCost ? (
            <div>
              <dt className="text-text-muted">{t('products.avg_cost')}</dt>
              <dd>
                <MoneyText paisa={result.total_cost} />
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-text-muted">
              {t('products.available_bundles')}
            </dt>
            <dd>
              {available === null
                ? t('products.made_to_order')
                : t('products.bundle_count', { count: available })}
            </dd>
          </div>
        </dl>
      ) : null}
      <p className="text-small text-text-muted">
        {t('form.bundle_recipe_hint')}
      </p>
    </fieldset>
  );
}
