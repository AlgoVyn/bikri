import {
  type Block,
  formatReceiptMoney,
  formatReceiptPhone,
  formatTaxRate,
  itemLayoutFor,
  POWERED_BY,
  renderReceiptText,
} from '@bikri/printer';
import { useTranslation } from 'react-i18next';

export type PreviewShop = {
  name: string;
  address: string;
  phone: string;
  header: string;
  footer: string;
  tax_rate_bp: number;
  inclusive: boolean;
};

const SAMPLE_PRICE = 4_200_000;

/** Sample 80 mm receipt for the wizard and Settings → Receipt (screens/01 step 3). */
export function previewBlocks(shop: PreviewShop): Block[] {
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
      text: `Tel: ${formatReceiptPhone(shop.phone)}`,
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
      left: 'Subtotal (1 item)',
      right: formatReceiptMoney(SAMPLE_PRICE),
    },
  );
  if (tax > 0)
    blocks.push({
      t: 'pair',
      left: `Sales tax ${formatTaxRate(shop.tax_rate_bp)}%`,
      right: formatReceiptMoney(tax),
    });
  blocks.push(
    { t: 'rule', char: '=' },
    {
      t: 'pair',
      left: 'TOTAL',
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
      left: `Includes Sales tax ${formatTaxRate(shop.tax_rate_bp)}%`,
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
}: {
  shop: PreviewShop;
  logoUrl: string | null;
}) {
  const { t } = useTranslation();
  const text = renderReceiptText(previewBlocks(shop), {
    charsPerLine: 48,
    itemLayout: itemLayoutFor(48, 80),
  });
  return (
    <figure
      className="rounded-card border border-border bg-white p-3 text-black"
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
