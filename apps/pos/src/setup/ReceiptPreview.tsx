import {
  type Block,
  formatReceiptMoney,
  formatReceiptPhone,
  formatTaxRate,
  itemLayoutFor,
  POWERED_BY,
  receiptLabelsFor,
  renderReceiptText,
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
      ? Math.round((SAMPLE_PRICE * shop.tax_rate_bp) / 10_000)
      : 0;
  const blocks: Block[] = [{ t: 'logo' }];
  if (shop.name.trim())
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
    const inside = Math.round(
      (SAMPLE_PRICE * shop.tax_rate_bp) / (10_000 + shop.tax_rate_bp),
    );
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
}: {
  shop: PreviewShop;
  logoUrl: string | null;
  paperMm?: 58 | 80;
}) {
  const { t, i18n } = useTranslation();
  const charsPerLine = paperMm === 58 ? 32 : 48;
  const text = renderReceiptText(previewBlocks(shop, i18n.language), {
    charsPerLine,
    itemLayout: itemLayoutFor(charsPerLine, paperMm),
  });
  return (
    <figure
      className="mx-auto w-fit max-w-full rounded-card border border-border bg-white p-3 text-black"
      data-testid="receipt-preview-card"
      dir="ltr"
    >
      <figcaption className="mb-2 text-small text-text-muted">
        {t('setup.preview')}
      </figcaption>
      {logoUrl ? (
        <img
          src={logoUrl}
          alt={t('setup.logo_preview')}
          className="mx-auto mb-1 max-w-[60%]"
        />
      ) : null}
      <pre
        data-testid="receipt-preview"
        className="overflow-x-auto font-mono text-[10px] leading-tight"
      >
        {text}
      </pre>
    </figure>
  );
}
