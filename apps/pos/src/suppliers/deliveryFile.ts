import { canvasFont, prepareCanvasFonts } from '../lib/canvasFont.ts';
import { csvCell, qtyCsv, rupeesCsv } from '../lib/csv.ts';
import { formatShopMoney } from '../lib/money.ts';
import { CANVAS } from '../lib/palette.ts';
import { canvasBlob, jpegToPdf } from '../print/receiptImage.ts';

export type DeliveryFileLine = {
  name: string;
  qtyMilli: number;
  unitCost: number;
  lineTotal: number;
  returnedMilli: number;
};

export type DeliveryFileReturn = {
  date: string;
  reason: string;
  total: number;
  refundReceived: number;
};

export type DeliveryFileMeta = {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  supplierName: string;
  invoiceNo: string;
  date: string;
  lines: readonly DeliveryFileLine[];
  otherCharges: number;
  total: number;
  paidNow: number;
  paidMethod: string;
  balance: number;
  note: string;
  returns: readonly DeliveryFileReturn[];
  lang: string;
  labels: {
    title: string;
    supplier: string;
    invoice: string;
    date: string;
    product: string;
    qty: string;
    returned: string;
    unitCost: string;
    lineTotal: string;
    itemsTotal: string;
    otherCharges: string;
    total: string;
    paidNow: string;
    balanceNow: string;
    note: string;
    returns: string;
    returnTotal: string;
    refundReceived: string;
    generatedBy: string;
  };
};

const WIDTH = 1240;
const MARGIN = 64;
const ROW = 38;

function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let end = text.length;
  while (end > 0) {
    const candidate = `${text.slice(0, end).trimEnd()}…`;
    if (ctx.measureText(candidate).width <= maxWidth) return candidate;
    end -= 1;
  }
  return '…';
}

async function draw(meta: DeliveryFileMeta): Promise<HTMLCanvasElement> {
  await prepareCanvasFonts(meta.lang);
  const summaryHeight = 150;
  const returnsHeight =
    meta.returns.length > 0 ? 68 + meta.returns.length * 32 : 0;
  const noteHeight = meta.note.trim() ? 70 : 0;
  const height = Math.max(
    1754,
    250 +
      summaryHeight +
      meta.lines.length * ROW +
      returnsHeight +
      noteHeight +
      220,
  );
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not available');
  ctx.fillStyle = CANVAS.paper;
  ctx.fillRect(0, 0, WIDTH, height);

  ctx.fillStyle = CANVAS.primary;
  ctx.fillRect(0, 0, WIDTH, 180);
  ctx.fillStyle = CANVAS.paper;
  ctx.font = canvasFont(meta.lang, 700, 34);
  ctx.fillText(fitText(ctx, meta.shopName, 620), MARGIN, 76);
  ctx.globalAlpha = 0.84;
  ctx.font = canvasFont(meta.lang, 400, 16);
  if (meta.shopAddress.trim())
    ctx.fillText(fitText(ctx, meta.shopAddress, 620), MARGIN, 108);
  if (meta.shopPhone.trim())
    ctx.fillText(`${meta.shopPhone.trim()}`, MARGIN, 136);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'right';
  ctx.font = canvasFont(meta.lang, 700, 26);
  ctx.fillText(meta.labels.title, WIDTH - MARGIN, 76);
  ctx.globalAlpha = 0.84;
  ctx.font = canvasFont(meta.lang, 400, 17);
  ctx.fillText(
    fitText(ctx, `${meta.labels.invoice}: ${meta.invoiceNo}`, 520),
    WIDTH - MARGIN,
    110,
  );
  ctx.fillText(`${meta.labels.date}: ${meta.date}`, WIDTH - MARGIN, 138);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';

  // Supplier strip.
  ctx.fillStyle = CANVAS.surface2;
  ctx.fillRect(MARGIN, 204, WIDTH - MARGIN * 2, 88);
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 400, 15);
  ctx.fillText(meta.labels.supplier, MARGIN + 24, 232);
  ctx.fillStyle = CANVAS.ink;
  ctx.font = canvasFont(meta.lang, 700, 24);
  ctx.fillText(fitText(ctx, meta.supplierName, 900), MARGIN + 24, 266);

  const tableY = 322;
  const cols = {
    name: MARGIN,
    qty: 700,
    unit: 850,
    total: 1040,
    end: WIDTH - MARGIN,
  };
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 700, 15);
  ctx.fillText(meta.labels.product, cols.name, tableY + 28);
  ctx.fillText(meta.labels.qty, cols.qty, tableY + 28);
  ctx.fillText(meta.labels.unitCost, cols.unit, tableY + 28);
  ctx.textAlign = 'right';
  ctx.fillText(meta.labels.lineTotal, cols.end, tableY + 28);
  ctx.textAlign = 'left';
  ctx.fillStyle = CANVAS.rule;
  ctx.fillRect(MARGIN, tableY + 46, WIDTH - MARGIN * 2, 1);

  let y = tableY + 78;
  meta.lines.forEach((line, index) => {
    if (index % 2 === 1) {
      ctx.fillStyle = CANVAS.stripe;
      ctx.fillRect(MARGIN, y - 25, WIDTH - MARGIN * 2, ROW);
    }
    ctx.fillStyle = CANVAS.ink;
    ctx.font = canvasFont(meta.lang, 500, 18);
    const returned =
      line.returnedMilli > 0
        ? ` · ${meta.labels.returned} ${qtyCsv(line.returnedMilli)}`
        : '';
    ctx.fillText(
      fitText(ctx, `${line.name}${returned}`, cols.qty - cols.name - 32),
      cols.name,
      y,
    );
    ctx.font = canvasFont(meta.lang, 400, 17);
    ctx.fillStyle = CANVAS.muted;
    ctx.fillText(qtyCsv(line.qtyMilli), cols.qty, y);
    ctx.fillText(formatShopMoney(line.unitCost), cols.unit, y);
    ctx.fillStyle = CANVAS.ink;
    ctx.textAlign = 'right';
    ctx.fillText(formatShopMoney(line.lineTotal), cols.end, y);
    ctx.textAlign = 'left';
    y += ROW;
  });

  y += 18;
  const totalX = 720;
  const valueX = WIDTH - MARGIN;
  const row = (label: string, value: string, bold = false) => {
    ctx.fillStyle = bold ? CANVAS.ink : CANVAS.muted;
    ctx.font = canvasFont(meta.lang, bold ? 700 : 400, bold ? 19 : 17);
    ctx.fillText(label, totalX, y);
    ctx.fillStyle = CANVAS.ink;
    ctx.font = canvasFont(meta.lang, bold ? 700 : 500, bold ? 20 : 17);
    ctx.textAlign = 'right';
    ctx.fillText(value, valueX, y);
    ctx.textAlign = 'left';
    y += bold ? 32 : 27;
  };
  row(meta.labels.itemsTotal, formatShopMoney(meta.total - meta.otherCharges));
  if (meta.otherCharges !== 0)
    row(meta.labels.otherCharges, formatShopMoney(meta.otherCharges));
  row(meta.labels.total, formatShopMoney(meta.total), true);
  row(
    meta.labels.paidNow,
    `${formatShopMoney(meta.paidNow)}${meta.paidMethod ? ` · ${meta.paidMethod}` : ''}`,
  );
  row(meta.labels.balanceNow, formatShopMoney(meta.balance));

  if (meta.returns.length > 0) {
    y += 16;
    ctx.fillStyle = CANVAS.ink;
    ctx.font = canvasFont(meta.lang, 700, 20);
    ctx.fillText(meta.labels.returns, MARGIN, y);
    y += 28;
    for (const item of meta.returns) {
      ctx.fillStyle = CANVAS.muted;
      ctx.font = canvasFont(meta.lang, 400, 16);
      ctx.fillText(
        fitText(ctx, `${item.date} · ${item.reason}`, 680),
        MARGIN,
        y,
      );
      ctx.fillStyle = CANVAS.ink;
      ctx.font = canvasFont(meta.lang, 500, 16);
      ctx.textAlign = 'right';
      const returnRight = WIDTH - MARGIN - 300;
      const refundRight = WIDTH - MARGIN;
      ctx.fillText(
        fitText(
          ctx,
          `${meta.labels.returnTotal}: ${formatShopMoney(item.total)}`,
          280,
        ),
        returnRight,
        y,
      );
      ctx.fillText(
        fitText(
          ctx,
          `${meta.labels.refundReceived}: ${formatShopMoney(item.refundReceived)}`,
          280,
        ),
        refundRight,
        y,
      );
      ctx.textAlign = 'left';
      y += 30;
    }
  }

  if (meta.note.trim()) {
    y += 18;
    ctx.fillStyle = CANVAS.muted;
    ctx.font = canvasFont(meta.lang, 400, 16);
    ctx.fillText(
      fitText(
        ctx,
        `${meta.labels.note}: ${meta.note.trim()}`,
        WIDTH - MARGIN * 2,
      ),
      MARGIN,
      y,
    );
  }

  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 400, 14);
  ctx.fillText(meta.labels.generatedBy, MARGIN, height - 44);
  return canvas;
}

export function deliveryDetailCsv(meta: DeliveryFileMeta): string {
  const header = [
    'invoice_no',
    'date',
    'supplier',
    'product',
    'qty',
    'unit_cost',
    'line_total',
    'returned_qty',
    'other_charges',
    'delivery_total',
    'paid_now',
    'paid_method',
    'supplier_balance',
    'note',
  ];
  const rows =
    meta.lines.length > 0
      ? meta.lines.map((line) => [
          meta.invoiceNo,
          meta.date,
          meta.supplierName,
          line.name,
          qtyCsv(line.qtyMilli),
          rupeesCsv(line.unitCost),
          rupeesCsv(line.lineTotal),
          qtyCsv(line.returnedMilli),
          rupeesCsv(meta.otherCharges),
          rupeesCsv(meta.total),
          rupeesCsv(meta.paidNow),
          meta.paidMethod,
          rupeesCsv(meta.balance),
          meta.note,
        ])
      : [
          [
            meta.invoiceNo,
            meta.date,
            meta.supplierName,
            '',
            '',
            '',
            '',
            '',
            rupeesCsv(meta.otherCharges),
            rupeesCsv(meta.total),
            rupeesCsv(meta.paidNow),
            meta.paidMethod,
            rupeesCsv(meta.balance),
            meta.note,
          ],
        ];
  return [header.join(',')]
    .concat(rows.map((row) => row.map(csvCell).join(',')))
    .join('\r\n');
}

export async function deliveryPng(meta: DeliveryFileMeta): Promise<Blob> {
  return canvasBlob(await draw(meta), 'image/png');
}

export async function deliveryPdf(meta: DeliveryFileMeta): Promise<Blob> {
  const canvas = await draw(meta);
  const jpeg = new Uint8Array(
    await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
  );
  return new Blob(
    [jpegToPdf(jpeg, canvas.width, canvas.height, 210) as BlobPart],
    {
      type: 'application/pdf',
    },
  );
}
