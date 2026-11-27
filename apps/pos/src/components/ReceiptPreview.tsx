import { mulDivRound } from '@bikri/core';
import {
  type Block,
  formatReceiptMoney,
  formatReceiptPhone,
  formatTaxRate,
  itemLayoutFor,
  POWERED_BY,
  receiptLabelsFor,
  receiptTextLines,
} from '@bikri/printer';
import { useTranslation } from 'react-i18next';
import { resolveReceiptLanguage } from '../data/receipt.ts';

export type PreviewShop = {
  name: string;
  address: string;
  phone: string;
  header: string;
  footer: string;
  tax_rate_bp: number;
  inclusive: boolean;
  tax_label?: string;
  receipt_language?: string;
  show_shop_name_on_receipt?: boolean;
  show_logo_on_receipt?: boolean;
};

const SAMPLE_PRICE = 4_200_000;

/** Sample 80 mm receipt for the wizard and Settings → Receipt (screens/01 step 3). */
export function previewBlocks(shop: PreviewShop, uiLanguage = 'en'): Block[] {
  const receiptLanguage = resolveReceiptLanguage(
    shop.receipt_language,
    uiLanguage,
  );
  const labels = receiptLabelsFor(receiptLanguage);
  const taxLabel =
    shop.tax_label?.trim() ||
    (receiptLanguage === 'ur' ? 'سیلز ٹیکس' : 'Sales tax');
  const tax =
    shop.tax_rate_bp > 0 && !shop.inclusive
      ? mulDivRound(SAMPLE_PRICE, shop.tax_rate_bp, 10_000)
      : 0;
  const blocks: Block[] =
    shop.show_logo_on_receipt !== false ? [{ t: 'logo' }] : [];
  if (shop.show_shop_name_on_receipt !== false && shop.name.trim())
    blocks.push({
      t: 'text',
      text: shop.name.trim().toUpperCase(),
      align: 'center',
      bold: true,
    });
  if (shop.address.trim())
    blocks.push({ t: 'text', text: shop.address.trim(), align: 'center' });
  if (shop.phone)
    blocks.push({
      t: 'text',
      text: `${labels.telPrefix} ${formatReceiptPhone(shop.phone)}`,
      align: 'center',
    });
  for (const line of shop.header.split('\n').filter((l) => l.trim())) {
    blocks.push({ t: 'text', text: line.trim(), align: 'center' });
  }
  blocks.push(
    { t: 'rule', char: '-' },
    {
      t: 'item',
      name: 'Samsung A15 4/128',
      qty: '1',
      amount: formatReceiptMoney(SAMPLE_PRICE),
    },
    { t: 'rule', char: '-' },
    {
      t: 'pair',
      left: labels.subtotalItem.replace('{n}', '1'),
      right: formatReceiptMoney(SAMPLE_PRICE),
    },
  );
  if (tax > 0)
    blocks.push({
      t: 'pair',
      left: labels.salesTax
        .replace('{label}', taxLabel)
        .replace('{rate}', formatTaxRate(shop.tax_rate_bp)),
      right: formatReceiptMoney(tax),
    });
  blocks.push(
    { t: 'rule', char: '=' },
    {
      t: 'pair',
      left: labels.total,
      right: formatReceiptMoney(SAMPLE_PRICE + tax),
      bold: true,
    },
  );
  if (shop.tax_rate_bp > 0 && shop.inclusive) {
    const inside =
      SAMPLE_PRICE -
      mulDivRound(SAMPLE_PRICE, 10_000, 10_000 + shop.tax_rate_bp);
    blocks.push({
      t: 'pair',
      left: labels.includesTax
        .replace('{label}', taxLabel)
        .replace('{rate}', formatTaxRate(shop.tax_rate_bp)),
      right: formatReceiptMoney(inside),
    });
  }
  blocks.push({ t: 'rule', char: '=' });
  for (const line of shop.footer.split('\n').filter((l) => l.trim())) {
    blocks.push({ t: 'text', text: line.trim(), align: 'center' });
  }
  blocks.push({ t: 'text', text: POWERED_BY, align: 'center', size: 'small' });
  return blocks;
}

export function ReceiptPreview({
  shop,
  logoUrl,
  paperMm = 80,
  charsPerLine,
}: {
  shop: PreviewShop;
  logoUrl: string | null;
  paperMm?: 58 | 80;
  /** Printer's current line width; defaults to the paper's full width. */
  charsPerLine?: number;
}) {
  const { t, i18n } = useTranslation();
  const chars = charsPerLine ?? (paperMm === 58 ? 32 : 48);
  const showLogo = shop.show_logo_on_receipt !== false;
  const lines = receiptTextLines(previewBlocks(shop, i18n.language), {
    charsPerLine: chars,
    itemLayout: itemLayoutFor(chars, paperMm),
  });
  return (
    <figure
      className="mx-auto w-fit max-w-full rounded-card border border-divider bg-white p-3 text-black"
      data-testid="receipt-preview-card"
      dir="ltr"
    >
      {/* The paper stays white in dark mode, so its caption uses the fixed navy token. */}
      <figcaption className="mb-2 text-small text-brand-navy">
        {t('setup.preview')}
      </figcaption>
      {/* The paper width comes from the receipt text (chars × monospace ch), never
          from the logo's intrinsic 576 px bitmap: that used to double the card and
          push the logo out of centre. The dithered bitmap already contains the
          printer's 60%-wide centred logo, so it is drawn at the paper width. */}
      <div
        className="mx-auto max-w-full font-mono text-receipt"
        style={{ width: `${chars}ch` }}
      >
        {showLogo && logoUrl ? (
          <img
            src={logoUrl}
            alt={t('setup.logo_preview')}
            className="mx-auto mb-1 block w-full"
          />
        ) : null}
        <div
          data-testid="receipt-preview"
          className="overflow-x-auto leading-tight [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {lines.map((line, index) => (
            <div
              // The receipt lines are stable and style-only; index is the only key.
              // biome-ignore lint/suspicious/noArrayIndexKey: rendered receipt rows have no id
              key={index}
              className={`whitespace-pre ${line.bold ? 'font-bold' : ''}`}
              style={{ textAlign: line.align }}
            >
              {line.cells && line.cells.length > 0 ? (
                <span
                  className={
                    line.cells.length > 2
                      ? 'grid grid-cols-[minmax(0,1fr)_5ch_15ch] gap-1'
                      : 'flex justify-between gap-2'
                  }
                >
                  {line.cells.map((cell, cellIndex) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: receipt cells have no id
                      key={cellIndex}
                      dir="auto"
                      className={
                        cell.align === 'end' ? 'text-end' : 'text-start'
                      }
                    >
                      {cell.text}
                    </span>
                  ))}
                </span>
              ) : (
                line.text || '\u00a0'
              )}
            </div>
          ))}
        </div>
      </div>
    </figure>
  );
}
