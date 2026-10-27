import { formatMoney } from '@bikri/core';
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
import { Modal } from '../sell/Modal.tsx';
import type { LabelSettings } from '../settings/LabelsPage.ts';
import { useCurrentStaff } from '../state/currentStaff.ts';

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
  const { t } = useTranslation();
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

  const searchMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return (data?.products ?? [])
      .filter(
        (product) =>
          String(product.name_en).toLowerCase().includes(q) ||
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
          ${settings.showShop ? `<div class="shop">${escapeHtml(data?.shopName ?? '')}</div>` : ''}
          <div class="name">${escapeHtml(String(product.name_en))}</div>
          ${settings.showPrice ? `<div class="price">${formatMoney(Number(product.price))}</div>` : ''}
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
      printHtml(labels, settings);
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
            className="flex flex-wrap items-center gap-2 p-2"
          >
            <span className="min-w-0 flex-[2_1_12rem]">
              <span className="block truncate font-medium">
                {String(row.product.name_en)}
              </span>
              <span className="block text-small text-text-muted">
                {row.barcode ?? t('office.labels.no_barcode')}
              </span>
            </span>
            {row.barcode ? (
              <MoneyText paisa={Number(row.product.price ?? 0)} />
            ) : can('catalog.edit') ? (
              <button
                type="button"
                className={buttonQuiet}
                onClick={() => void generate(row.product)}
              >
                {t('office.labels.generate')}
              </button>
            ) : (
              <span className="text-small text-text-muted">
                {t('office.labels.ask_manager')}
              </span>
            )}
            <div className="w-28">
              <QtyInput
                label={`${t('office.labels.copies')} ${String(row.product.name_en)}`}
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
            {String(product.name_en)}
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
        <label className="flex items-center gap-2 self-end text-small">
          <input
            type="checkbox"
            checked={settings.showShop}
            onChange={(event) =>
              setSettings({ ...settings, showShop: event.target.checked })
            }
          />
          {t('office.labels.show_shop')}
        </label>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
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

function printHtml(labels: string[], settings: LabelSettings): void {
  const size = LABEL_SIZES[settings.size];
  const frame = document.createElement('iframe');
  frame.style.position = 'fixed';
  frame.style.inset = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  document.body.append(frame);
  const doc = frame.contentDocument;
  if (!doc) {
    frame.remove();
    return;
  }
  const page =
    settings.size === 'a4'
      ? '@page { size: A4; margin: 12.9mm 9mm; }'
      : `@page { size: ${size.widthMm}mm ${size.heightMm}mm; margin: 0; }`;
  const skip =
    settings.size === 'a4'
      ? Array.from(
          { length: Math.min(23, settings.start) },
          () => '<div></div>',
        ).join('')
      : '';
  const grid =
    settings.size === 'a4'
      ? 'display:grid;grid-template-columns:repeat(3,64mm);grid-auto-rows:33.9mm;gap:0;'
      : '';
  const labelCss =
    settings.size === 'a4'
      ? 'width:64mm;height:33.9mm;box-sizing:border-box;padding:1.5mm;overflow:hidden;break-inside:avoid;'
      : `width:${size.widthMm}mm;height:${size.heightMm}mm;box-sizing:border-box;padding:1mm;overflow:hidden;break-after:page;`;
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{margin:0;font-family:Inter,Arial,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    ${page}
    .sheet{${grid}}
    .label{${labelCss}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.3mm;text-align:center}
    .shop{font-size:7pt;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}
    .name{font-size:8pt;font-weight:700;line-height:1.1;max-height:2.2em;overflow:hidden;width:100%}
    .price{font-size:10pt;font-weight:700;line-height:1.1}
    .bars{width:100%;display:flex;justify-content:center}
    .bars svg{display:block;max-width:100%;height:${size.barHeightMm}mm}
    .value{font-family:"JetBrains Mono",monospace;font-size:7pt;line-height:1.1;white-space:nowrap;max-width:100%;overflow:hidden}
  </style></head><body><div class="sheet">${skip}${labels.join('')}</div></body></html>`);
  doc.close();
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}
