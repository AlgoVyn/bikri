import type { MasterRow } from '@bikri/db';
import {
  barcodeLabelSvg,
  LABEL_SIZES,
  LabelError,
  type LabelSizeId,
} from '@bikri/printer';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { buttonPrimary, buttonQuiet } from '../components/classes.ts';
import { MoneyText } from '../components/MoneyText.tsx';
import { QtyInput } from '../components/QtyInput.tsx';
import { useToast } from '../components/Toast.tsx';
import { addProductBarcode, generateBarcode } from '../data/catalog.ts';
import { getDb } from '../data/db.ts';
import { getKv } from '../data/kv.ts';
import { AreaStrings } from '../i18n/areas.tsx';
import { formatShopMoney } from '../lib/money';
import { Modal } from '../sell/Modal.tsx';
import type { LabelSettings } from '../settings/LabelsPage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';
import { printLabelHtml } from './printLabels.ts';

export type LabelSeed = { productId: string; copies: number };

const DEFAULT: LabelSettings = {
  size: '50x25',
  showShop: false,
  showPrice: true,
  dpi: 203,
  start: 0,
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Print labels through the browser dialog (screens/20, T-052). */
export function LabelsDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: LabelSeed[];
}) {
  return (
    <AreaStrings area="office">
      <LabelsDialogContent
        open={open}
        onOpenChange={onOpenChange}
        initial={initial}
      />
    </AreaStrings>
  );
}

function LabelsDialogContent({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: LabelSeed[];
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { staff, can } = useCurrentStaff();
  const [rows, setRows] = useState<LabelSeed[]>([]);
  const [settings, setSettings] = useState<LabelSettings>(DEFAULT);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(initial);
    setQuery('');
    setError(null);
    setPrinting(false);
  }, [open, initial]);

  const data = useLiveQuery(async () => {
    const db = getDb();
    const products = (await db.products.toArray()).filter(
      (product) => !product.deleted_at,
    );
    const barcodes = (await db.product_barcodes.toArray()).filter(
      (barcode) => !barcode.deleted_at,
    );
    const shop = await db.shop.get('shop');
    const label = await getKv<LabelSettings>(db, 'label', DEFAULT);
    return {
      products,
      barcodes,
      shopName: String(shop?.name ?? ''),
      receiptLanguage: String(shop?.receipt_language ?? 'app'),
      label: { ...DEFAULT, ...label },
    };
  }, []);

  useEffect(() => {
    if (data?.label) setSettings({ ...DEFAULT, ...data.label });
  }, [data?.label]);

  const productById = useMemo(
    () =>
      new Map((data?.products ?? []).map((product) => [product.id, product])),
    [data?.products],
  );
  const barcodeByProduct = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of data?.barcodes ?? []) {
      const key = String(row.product_id);
      if (!map.has(key)) map.set(key, String(row.barcode));
    }
    return map;
  }, [data?.barcodes]);

  const rowsWithProducts = rows
    .map((row) => ({
      ...row,
      product: productById.get(row.productId) ?? null,
      barcode: barcodeByProduct.get(row.productId) ?? null,
    }))
    .filter(
      (row): row is typeof row & { product: MasterRow } => row.product !== null,
    );

  const urduLabels =
    data?.receiptLanguage === 'ur' ||
    (data?.receiptLanguage === 'app' && i18n.language === 'ur');
  const labelName = (product: MasterRow): string => {
    const ur = String(product.name_ur ?? '').trim();
    return urduLabels && ur !== '' ? ur : String(product.name_en);
  };

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (data?.products ?? [])
      .filter(
        (product) =>
          String(product.name_en).toLowerCase().includes(q) ||
          String(product.name_ur ?? '')
            .toLowerCase()
            .includes(q) ||
          String(product.sku).toLowerCase().includes(q),
      )
      .filter((product) => !rows.some((row) => row.productId === product.id))
      .slice(0, 8);
  }, [query, data?.products, rows]);

  const totalCopies = rowsWithProducts.reduce(
    (sum, row) => sum + (row.barcode ? Math.max(0, row.copies) : 0),
    0,
  );
  const first = rowsWithProducts.find((row) => row.copies > 0);
  let preview: { svg: string; widthMm: number } | null = null;
  let previewError: string | null = null;
  if (first?.barcode) {
    try {
      const label = barcodeLabelSvg(
        first.barcode,
        LABEL_SIZES[settings.size],
        settings.dpi,
      );
      preview = { svg: label.svg, widthMm: label.size.widthMm };
    } catch (err) {
      previewError =
        err instanceof LabelError && err.code === 'too_long'
          ? t('office.labels.too_long')
          : t('office.labels.charset');
    }
  }

  const generate = async (product: MasterRow) => {
    try {
      const code = await generateBarcode(getDb());
      await addProductBarcode(getDb(), product.id, code, staff?.id ?? null);
      toast.push(t('office.labels.generated', { code }));
    } catch {
      toast.push(t('errors.generic'), 'error');
    }
  };

  const addRow = (product: MasterRow) => {
    setRows((current) => [...current, { productId: product.id, copies: 1 }]);
    setQuery('');
  };

  const print = () => {
    if (printing || totalCopies === 0) return;
    if (totalCopies > 1_000) {
      setError(t('office.labels.max_labels'));
      return;
    }
    const labels: string[] = [];
    for (const row of rowsWithProducts) {
      if (row.copies <= 0 || !row.barcode) continue;
      let svg: { svg: string };
      try {
        svg = barcodeLabelSvg(
          row.barcode,
          LABEL_SIZES[settings.size],
          settings.dpi,
        );
      } catch (err) {
        setError(
          err instanceof LabelError && err.code === 'too_long'
            ? t('office.labels.too_long')
            : t('office.labels.charset'),
        );
        return;
      }
      for (let index = 0; index < row.copies; index += 1) {
        const product = row.product;
        labels.push(`<div class="label">
          ${settings.showShop ? `<div class="shop" dir="auto">${escapeHtml(data?.shopName ?? '')}</div>` : ''}
          <div class="name" dir="auto">${escapeHtml(labelName(product))}</div>
          ${settings.showPrice ? `<div class="price">${formatShopMoney(Number(product.price))}</div>` : ''}
          <div class="bars">${svg.svg}</div>
          <div class="value">${escapeHtml(row.barcode)}</div>
        </div>`);
      }
    }
    if (labels.length === 0) {
      setError(t('office.labels.no_barcode'));
      return;
    }
    setError(null);
    setPrinting(true);
    try {
      printLabelHtml(labels, settings);
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('office.labels.dialog_title')}
      wide
    >
      {rowsWithProducts.length === 0 ? (
        <p className="text-small text-text-muted">{t('office.labels.empty')}</p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border rounded-card border border-border">
        {rowsWithProducts.map((row) => (
          <li
            key={row.productId}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 p-2 sm:grid-cols-[minmax(0,1fr)_10rem_9rem]"
          >
            <span className="col-span-2 min-w-0 sm:col-span-1">
              <span className="block truncate font-medium">
                {labelName(row.product)}
              </span>
              <span className="block text-small text-text-muted">
                {row.barcode ?? t('office.labels.no_barcode')}
              </span>
            </span>
            <span className="justify-self-start sm:justify-self-end">
              {row.barcode ? (
                <MoneyText paisa={Number(row.product.price ?? 0)} />
              ) : can('catalog.edit') ? (
                <button
                  type="button"
                  className={`${buttonQuiet} whitespace-nowrap`}
                  onClick={() => void generate(row.product)}
                >
                  {t('office.labels.generate')}
                </button>
              ) : (
                <span className="text-small text-text-muted">
                  {t('office.labels.ask_manager')}
                </span>
              )}
            </span>
            <div className="w-32 justify-self-end sm:w-36">
              <QtyInput
                dense
                label={t('office.labels.copies')}
                ariaLabel={`${t('office.labels.copies')} ${labelName(row.product)}`}
                unit="pc"
                value={row.copies * 1000}
                onChange={(value) =>
                  setRows((current) =>
                    current.map((item) =>
                      item.productId === row.productId
                        ? {
                            ...item,
                            copies: Math.max(
                              0,
                              Math.min(500, Math.round((value ?? 0) / 1000)),
                            ),
                          }
                        : item,
                    ),
                  )
                }
              />
            </div>
          </li>
        ))}
      </ul>

      <label className="flex flex-col gap-1 text-small">
        {t('office.labels.search')}
        <input
          className="h-11 w-full rounded-control border border-border-strong bg-surface px-3 text-text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('office.labels.search_placeholder')}
        />
      </label>
      <div className="flex flex-wrap gap-1">
        {searchMatches.map((product) => (
          <button
            key={product.id}
            type="button"
            className={`${buttonQuiet} px-3`}
            onClick={() => addRow(product)}
          >
            {labelName(product)}
          </button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-small">
          {t('office.labels.size')}
          <select
            className="h-11 rounded-control border border-border-strong bg-surface px-2"
            value={settings.size}
            onChange={(event) =>
              setSettings({
                ...settings,
                size: event.target.value as LabelSizeId,
              })
            }
          >
            <option value="50x25">{t('office.labels.size_50x25')}</option>
            <option value="38x25">{t('office.labels.size_38x25')}</option>
            <option value="40x30">{t('office.labels.size_40x30')}</option>
            <option value="a4">{t('office.labels.size_a4')}</option>
          </select>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5"
            checked={settings.showShop}
            onChange={(event) =>
              setSettings({ ...settings, showShop: event.target.checked })
            }
          />
          {t('office.labels.show_shop')}
        </label>
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            className="size-5"
            checked={settings.showPrice}
            onChange={(event) =>
              setSettings({ ...settings, showPrice: event.target.checked })
            }
          />
          {t('office.labels.show_price')}
        </label>
      </div>

      {preview ? (
        <div className="flex flex-col gap-1">
          <p className="text-small text-text-muted">
            {t('office.labels.preview')}
          </p>
          <div
            data-testid="label-preview"
            className="mx-auto w-full overflow-auto rounded-control border border-border bg-white p-2"
            style={{ maxWidth: `${Math.min(preview.widthMm * 2, 200)}mm` }}
          >
            <div
              className="mx-auto"
              style={{ width: `${preview.widthMm}mm` }}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: our own SVG
              dangerouslySetInnerHTML={{ __html: preview.svg }}
            />
          </div>
        </div>
      ) : null}
      {previewError ? (
        <p className="text-small text-danger">{previewError}</p>
      ) : null}
      {error ? <p className="text-small text-danger">{error}</p> : null}
      <p className="text-small text-text-muted">
        {t('office.labels.print_hint')}
      </p>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          className={buttonQuiet}
          onClick={() => onOpenChange(false)}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className={buttonPrimary}
          disabled={totalCopies === 0 || printing}
          onClick={print}
        >
          {t('office.labels.print_n', { count: totalCopies })}
        </button>
      </div>
    </Modal>
  );
}
