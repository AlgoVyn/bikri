import { QTY_UNITS, type QtyUnit } from '@bikri/core';
import {
  Box,
  Button,
  Checkbox,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { Navigate, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { ProductsIcon } from '../components/icons.tsx';
import { MoneyInput } from '../components/MoneyInput.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { SubpageHeader } from '../components/SubpageHeader.tsx';
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
import { categoryName } from '../lib/category.ts';
import { useHotkey } from '../shell/hotkeys.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { useReadOnly } from '../state/readOnly.ts';
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

  if (readOnly) return <Navigate to="/products" replace />;

  return (
    <Box
      component="form"
      mx="auto"
      maw={896}
      p="md"
      pb={112}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
    >
      <SubpageHeader
        backTo="/products"
        backLabel={t('import.back_to_products')}
        icon={<ProductsIcon />}
        title={isEdit ? t('form.edit_title') : t('form.new_title')}
      />

      <Paper withBorder p="lg">
        <Stack gap="lg">
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
            <Button component="label" variant="default">
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
            </Button>
            {(draft.photo === undefined && existingKey) || draft.photo ? (
              <Button
                type="button"
                variant="default"
                onClick={() => {
                  set('photo', existingKey ? null : undefined);
                  setPhotoUrl(null);
                }}
              >
                {t('form.photo_remove')}
              </Button>
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

          <TextInput
            ref={nameRef}
            id={fieldId('name_en')}
            label={t('form.name_en')}
            maxLength={80}
            value={draft.name_en}
            error={errors.name_en}
            aria-invalid={errors.name_en ? true : undefined}
            aria-describedby={
              errors.name_en
                ? `${fieldId('name_en')}-error`
                : sameName
                  ? `${fieldId('name_en')}-warn`
                  : undefined
            }
            onChange={(event) => set('name_en', event.currentTarget.value)}
          />
          {!errors.name_en && sameName ? (
            <Text
              id={`${fieldId('name_en')}-warn`}
              size="sm"
              c="var(--color-warning)"
            >
              {t('form.name_duplicate')}
            </Text>
          ) : null}
          <TextInput
            id={fieldId('name_ur')}
            label={t('form.name_ur')}
            dir="rtl"
            lang="ur"
            className="font-urdu"
            maxLength={80}
            value={draft.name_ur}
            onChange={(event) => set('name_ur', event.currentTarget.value)}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
            <Box>
              <Group gap="xs" align="flex-end" wrap="nowrap">
                <NativeSelect
                  id={fieldId('category')}
                  label={t('form.category')}
                  value={draft.category_id}
                  onChange={(event) =>
                    set('category_id', event.currentTarget.value)
                  }
                  data={[
                    { value: '', label: t('form.no_category') },
                    ...categories.map((c) => ({
                      value: c.id,
                      label: categoryName(c, i18n.language),
                    })),
                  ]}
                  style={{ flex: 1 }}
                />
                <Button
                  type="button"
                  variant="default"
                  onClick={() => setNewCategory('')}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {t('form.new_category')}
                </Button>
              </Group>
              {newCategory !== null ? (
                <Group gap="xs" mt="xs" wrap="nowrap">
                  <TextInput
                    id={fieldId('new-category')}
                    aria-label={t('form.new_category_name')}
                    placeholder={t('form.new_category_name')}
                    maxLength={40}
                    data-autofocus
                    value={newCategory}
                    onChange={(event) =>
                      setNewCategory(event.currentTarget.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        (
                          event.currentTarget
                            .nextElementSibling as HTMLButtonElement | null
                        )?.click();
                      }
                    }}
                    style={{ flex: 1 }}
                  />
                  <Button
                    type="button"
                    variant="default"
                    disabled={!newCategory.trim()}
                    onClick={async () => {
                      const created = await addCategory(
                        getDb(),
                        newCategory,
                        't1',
                        { actor: staff?.id ?? null },
                      );
                      set('category_id', created.id);
                      setNewCategory(null);
                    }}
                  >
                    {t('form.add')}
                  </Button>
                </Group>
              ) : null}
            </Box>
            <Box>
              <TextInput
                id={fieldId('brand')}
                label={t('form.brand')}
                maxLength={40}
                list={fieldId('brands')}
                value={draft.brand}
                onChange={(event) => set('brand', event.currentTarget.value)}
              />
              <datalist id={fieldId('brands')}>
                {brands.map((b) => (
                  <option key={b} value={b} />
                ))}
              </datalist>
            </Box>
          </SimpleGrid>

          <Box
            component="fieldset"
            style={{ border: 0, margin: 0, padding: 0 }}
          >
            <Text component="legend" size="sm" mb="xs">
              {t('products.barcodes')}
            </Text>
            <Stack gap="sm">
              {draft.barcodes.map((code, i) => {
                const key = `barcode-${i}`;
                const err = errors.barcodes?.[i];
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: barcode rows have no id until saved
                  <Group key={i} gap="xs" align="flex-start" wrap="nowrap">
                    <TextInput
                      id={fieldId(key)}
                      aria-label={t('form.barcode', { n: i + 1 })}
                      dir="ltr"
                      inputMode="numeric"
                      maxLength={64}
                      value={code}
                      error={err}
                      style={{ flex: 1 }}
                      aria-invalid={err ? true : undefined}
                      aria-describedby={
                        err ? `${fieldId(key)}-error` : undefined
                      }
                      onChange={(event) =>
                        set(
                          'barcodes',
                          draft.barcodes.map((b, j) =>
                            j === i ? event.currentTarget.value : b,
                          ),
                        )
                      }
                    />
                    {draft.barcodes.length > 1 ? (
                      <Button
                        type="button"
                        variant="default"
                        aria-label={t('form.remove_barcode', { n: i + 1 })}
                        onClick={() =>
                          set(
                            'barcodes',
                            draft.barcodes.filter((_, j) => j !== i),
                          )
                        }
                      >
                        ×
                      </Button>
                    ) : null}
                  </Group>
                );
              })}
              <Group gap="xs">
                <Button
                  type="button"
                  variant="default"
                  onClick={() => set('barcodes', [...draft.barcodes, ''])}
                >
                  {t('form.add_barcode')}
                </Button>
                <Button
                  type="button"
                  variant="default"
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
                </Button>
              </Group>
            </Stack>
          </Box>

          <Box>
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <TextInput
                id={fieldId('sku')}
                label={t('form.sku')}
                dir="ltr"
                maxLength={40}
                value={draft.sku}
                error={errors.sku}
                description={errors.sku ? undefined : t('form.sku_hint')}
                aria-invalid={errors.sku ? true : undefined}
                aria-describedby={
                  errors.sku
                    ? `${fieldId('sku')}-error`
                    : `${fieldId('sku')}-hint`
                }
                onChange={(event) => set('sku', event.currentTarget.value)}
                style={{ flex: 1 }}
              />
              <Button
                type="button"
                variant="default"
                style={{ whiteSpace: 'nowrap' }}
                onClick={async () =>
                  set('sku', await uniqueSku(getDb(), draft.name_en || 'item'))
                }
              >
                {t('form.generate_sku')}
              </Button>
            </Group>
          </Box>

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
              <NativeSelect
                id={fieldId('unit')}
                label={t('form.unit')}
                value={draft.unit}
                onChange={(event) =>
                  set('unit', event.currentTarget.value as QtyUnit)
                }
                data={QTY_UNITS.map((u) => ({
                  value: u,
                  label: t(`unit.${u}`),
                }))}
              />
            </div>
            <Checkbox
              label={t('form.track_stock')}
              checked={draft.track_stock}
              onChange={(event) =>
                set('track_stock', event.currentTarget.checked)
              }
              style={{ alignSelf: 'end', marginBottom: 10 }}
            />
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
              <NativeSelect
                id={fieldId('warranty')}
                label={t('form.warranty')}
                value={draft.warranty}
                onChange={(event) => set('warranty', event.currentTarget.value)}
                data={[
                  { value: '0', label: t('form.warranty_none') },
                  { value: '7', label: t('form.warranty_7') },
                  { value: '30', label: t('form.warranty_30') },
                  { value: '90', label: t('form.warranty_90') },
                  { value: '180', label: t('form.warranty_180') },
                  { value: '365', label: t('form.warranty_365') },
                  { value: 'custom', label: t('form.warranty_custom') },
                ]}
              />
            </div>
            {draft.warranty === 'custom' ? (
              <div>
                <TextInput
                  id={fieldId('warranty_days')}
                  label={t('form.warranty_days')}
                  inputMode="numeric"
                  dir="ltr"
                  value={draft.warranty_days}
                  error={errors.warranty_days}
                  aria-invalid={errors.warranty_days ? true : undefined}
                  aria-describedby={
                    errors.warranty_days
                      ? `${fieldId('warranty_days')}-error`
                      : undefined
                  }
                  onChange={(event) =>
                    set(
                      'warranty_days',
                      event.currentTarget.value.replace(/\D/gu, ''),
                    )
                  }
                />
              </div>
            ) : null}
          </div>

          <div>
            <Textarea
              id={fieldId('notes')}
              label={t('form.notes')}
              minRows={3}
              maxLength={500}
              value={draft.notes}
              onChange={(event) => set('notes', event.currentTarget.value)}
            />
          </div>
        </Stack>
      </Paper>

      <div className="fixed inset-x-0 bottom-[76px] z-20 border-t border-border bg-surface px-4 py-2 shadow-topbar lg:bottom-0 lg:start-[88px]">
        <Group justify="flex-end" gap="sm" mx="auto" w="100%" maw={896}>
          <Button
            variant="default"
            onClick={() => (dirty ? setConfirmDiscard(true) : leave())}
          >
            {t('common.cancel')}
          </Button>
          {isEdit ? null : (
            <Button
              variant="default"
              disabled={saving}
              onClick={() => void submit(true)}
            >
              {t('form.save_another')}
            </Button>
          )}
          <Button type="submit" disabled={saving}>
            {t('form.save')}
          </Button>
        </Group>
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
    </Box>
  );
}
