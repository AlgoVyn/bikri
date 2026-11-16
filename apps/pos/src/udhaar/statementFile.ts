import type { RasterSource } from '@bikri/printer';
import type { StatementItem } from '../data/udhaar.ts';
import { canvasFont, prepareCanvasFonts } from '../lib/canvasFont.ts';
import { qtyCsv } from '../lib/csv.ts';
import { formatShopMoney } from '../lib/money';
import { CANVAS } from '../lib/palette.ts';
import { canvasBlob, jpegToPdf } from '../print/receiptImage.ts';

export type StatementFileRow = {
  date: string;
  /** Compact DD/MM/YY date for the thermal print. */
  dateShort?: string;
  /** Shorter description for the thermal print. */
  descriptionShort?: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  /** Opt-in sale-line details for a detailed export. */
  items?: readonly StatementItem[];
};

export type StatementFileMeta = {
  shopName: string;
  shopAddress: string;
  shopPhone: string;
  /** Gray/RGBA shop logo from `kv.logo_bitmap`. */
  logo?: RasterSource | null;
  customerName: string;
  phone: string;
  balance: number;
  from: string | null;
  to: string | null;
  rows: readonly StatementFileRow[];
  openingBalance: number;
  lang?: string;
  labels: {
    title: string;
    customer: string;
    phone: string;
    period: string;
    periodValue: string;
    date: string;
    description: string;
    debit: string;
    credit: string;
    balance: string;
    opening: string;
    total: string;
    totalDebit: string;
    totalCredit: string;
    closing: string;
    generatedBy: string;
    asOf: string;
  };
};

const WIDTH = 1240;
const MARGIN = 64;
const ROW = 40;
const ITEM_ROW = 27;
/** Breathing room between a bill's item block and the next ledger entry. */
const ITEM_GAP = 24;
/** A4 at 150 dpi; longer statements grow this one page instead of clipping. */
const MIN_HEIGHT = 1754;
const CARD_GAP = 16;

function rounded(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

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

/** Scales a gray/RGBA bitmap with nearest-neighbour sampling; no network or Image decode. */
function drawBitmap(
  ctx: CanvasRenderingContext2D,
  source: RasterSource,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const image = ctx.createImageData(width, height);
  const gray = source.format === 'gray';
  for (let py = 0; py < height; py += 1) {
    const sy = Math.min(
      source.height - 1,
      Math.floor((py * source.height) / height),
    );
    for (let px = 0; px < width; px += 1) {
      const sx = Math.min(
        source.width - 1,
        Math.floor((px * source.width) / width),
      );
      const out = (py * width + px) * 4;
      if (gray) {
        const value = source.data[sy * source.width + sx] ?? 255;
        image.data[out] = value;
        image.data[out + 1] = value;
        image.data[out + 2] = value;
      } else {
        const at = (sy * source.width + sx) * 4;
        image.data[out] = source.data[at] ?? 255;
        image.data[out + 1] = source.data[at + 1] ?? 255;
        image.data[out + 2] = source.data[at + 2] ?? 255;
      }
      image.data[out + 3] = 255;
    }
  }
  ctx.putImageData(
    image,
    Math.round(x + (maxWidth - width) / 2),
    Math.round(y + (maxHeight - height) / 2),
  );
  return { width, height };
}

/** A4 bank-style statement: branded header, account strip, summary cards, ruled ledger. */
async function draw(meta: StatementFileMeta): Promise<HTMLCanvasElement> {
  await prepareCanvasFonts(meta.lang);
  const extras = meta.openingBalance !== 0 ? 1 : 0;
  const itemRows = meta.rows.reduce(
    (count, row) => count + (row.items?.length ?? 0),
    0,
  );
  const itemGroups = meta.rows.filter(
    (row) => (row.items?.length ?? 0) > 0,
  ).length;
  const totalDebit = meta.rows.reduce((sum, row) => sum + row.debit, 0);
  const totalCredit = meta.rows.reduce((sum, row) => sum + row.credit, 0);
  const closingBalance = meta.rows.at(-1)?.balance ?? meta.openingBalance;
  const tableY = 470;
  const contentBottom =
    tableY +
    48 +
    30 +
    (meta.rows.length + extras) * ROW +
    itemRows * ITEM_ROW +
    itemGroups * ITEM_GAP +
    150;
  const height = Math.max(MIN_HEIGHT, contentBottom + 30);
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not available');
  ctx.fillStyle = CANVAS.paper;
  ctx.fillRect(0, 0, WIDTH, height);

  // Branded header band with a white logo card.
  ctx.fillStyle = CANVAS.primary;
  ctx.fillRect(0, 0, WIDTH, 180);
  const cardX = MARGIN;
  const cardY = 40;
  const cardW = 196;
  const cardH = 100;
  ctx.fillStyle = CANVAS.paper;
  rounded(ctx, cardX, cardY, cardW, cardH, 12);
  ctx.fill();
  const logo = meta.logo
    ? drawBitmap(ctx, meta.logo, cardX + 12, cardY + 12, cardW - 24, cardH - 24)
    : null;
  if (!logo) {
    ctx.fillStyle = CANVAS.primary;
    rounded(ctx, cardX + 14, cardY + 14, 72, 72, 12);
    ctx.fill();
    ctx.fillStyle = CANVAS.paper;
    ctx.font = canvasFont(meta.lang, 700, 34);
    ctx.textAlign = 'center';
    ctx.fillText(
      (meta.shopName.trim()[0] ?? 'B').toUpperCase(),
      cardX + 50,
      cardY + 62,
    );
    ctx.textAlign = 'left';
  }
  const shopTextX = cardX + cardW + 28;
  ctx.fillStyle = CANVAS.paper;
  ctx.font = canvasFont(meta.lang, 700, 34);
  ctx.fillText(
    fitText(ctx, meta.shopName, WIDTH - MARGIN - shopTextX - 330),
    shopTextX,
    82,
  );
  ctx.globalAlpha = 0.84;
  ctx.font = canvasFont(meta.lang, 400, 18);
  if (meta.shopAddress.trim())
    ctx.fillText(
      fitText(ctx, meta.shopAddress.trim(), WIDTH - MARGIN - shopTextX - 330),
      shopTextX,
      114,
    );
  if (meta.shopPhone.trim())
    ctx.fillText(
      `${meta.labels.phone}: ${meta.shopPhone.trim()}`,
      shopTextX,
      142,
    );
  ctx.globalAlpha = 1;
  ctx.textAlign = 'right';
  ctx.font = canvasFont(meta.lang, 700, 26);
  ctx.fillText(meta.labels.title, WIDTH - MARGIN, 82);
  ctx.globalAlpha = 0.84;
  ctx.font = canvasFont(meta.lang, 400, 16);
  ctx.fillText(meta.labels.asOf, WIDTH - MARGIN, 112);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';

  // Customer + period strip.
  ctx.fillStyle = CANVAS.surface2;
  rounded(ctx, MARGIN, 204, WIDTH - MARGIN * 2, 104, 10);
  ctx.fill();
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 400, 15);
  ctx.fillText(meta.labels.customer, MARGIN + 24, 234);
  ctx.fillStyle = CANVAS.ink;
  ctx.font = canvasFont(meta.lang, 700, 24);
  ctx.fillText(fitText(ctx, meta.customerName, 560), MARGIN + 24, 268);
  if (meta.phone.trim()) {
    ctx.fillStyle = CANVAS.muted;
    ctx.font = canvasFont(meta.lang, 400, 17);
    ctx.fillText(
      `${meta.labels.phone}: ${meta.phone.trim()}`,
      MARGIN + 24,
      292,
    );
  }
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 400, 15);
  ctx.textAlign = 'right';
  ctx.fillText(meta.labels.period, WIDTH - MARGIN - 24, 234);
  ctx.fillStyle = CANVAS.ink;
  ctx.font = canvasFont(meta.lang, 700, 19);
  ctx.fillText(meta.labels.periodValue, WIDTH - MARGIN - 24, 268);
  ctx.textAlign = 'left';

  // Summary cards.
  const cardWidth = (WIDTH - MARGIN * 2 - CARD_GAP * 3) / 4;
  const cards = [
    { label: meta.labels.opening, value: meta.openingBalance },
    { label: meta.labels.totalDebit, value: totalDebit },
    { label: meta.labels.totalCredit, value: totalCredit },
    { label: meta.labels.closing, value: closingBalance },
  ];
  cards.forEach((card, index) => {
    const x = MARGIN + index * (cardWidth + CARD_GAP);
    ctx.fillStyle = CANVAS.surface2;
    rounded(ctx, x, 336, cardWidth, 92, 10);
    ctx.fill();
    ctx.fillStyle = CANVAS.muted;
    ctx.font = canvasFont(meta.lang, 400, 15);
    ctx.fillText(fitText(ctx, card.label, cardWidth - 32), x + 16, 366);
    ctx.fillStyle = index === 3 ? CANVAS.primary : CANVAS.ink;
    ctx.font = canvasFont(meta.lang, 700, 23);
    ctx.fillText(
      fitText(ctx, formatShopMoney(card.value), cardWidth - 32),
      x + 16,
      402,
    );
  });

  // Ledger table.
  const cols = {
    date: MARGIN + 20,
    description: MARGIN + 200,
    debit: 860,
    credit: 1000,
    balance: WIDTH - MARGIN - 20,
  };
  ctx.fillStyle = CANVAS.surface2;
  ctx.fillRect(MARGIN, tableY, WIDTH - MARGIN * 2, 48);
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 700, 15);
  ctx.fillText(meta.labels.date, cols.date, tableY + 30);
  ctx.fillText(meta.labels.description, cols.description, tableY + 30);
  ctx.textAlign = 'right';
  ctx.fillText(meta.labels.debit, cols.debit, tableY + 30);
  ctx.fillText(meta.labels.credit, cols.credit, tableY + 30);
  ctx.fillText(meta.labels.balance, cols.balance, tableY + 30);
  ctx.textAlign = 'left';
  ctx.strokeStyle = CANVAS.rule;
  ctx.beginPath();
  ctx.moveTo(MARGIN, tableY + 48);
  ctx.lineTo(WIDTH - MARGIN, tableY + 48);
  ctx.stroke();

  let y = tableY + 48 + 28;
  const drawRow = (values: StatementFileRow | null, index: number): void => {
    if (values && index % 2 === 1) {
      ctx.fillStyle = CANVAS.stripe;
      ctx.fillRect(MARGIN, y - 24, WIDTH - MARGIN * 2, ROW);
    }
    ctx.font = canvasFont(meta.lang, 400, 18);
    ctx.fillStyle = CANVAS.ink;
    if (!values) {
      ctx.fillText(meta.labels.opening, cols.description, y);
      ctx.textAlign = 'right';
      ctx.fillText(formatShopMoney(meta.openingBalance), cols.balance, y);
      ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = CANVAS.muted;
      ctx.font = canvasFont(meta.lang, 400, 16);
      ctx.fillText(values.date, cols.date, y);
      ctx.fillStyle = CANVAS.ink;
      ctx.font = canvasFont(meta.lang, 400, 18);
      ctx.fillText(
        fitText(ctx, values.description, cols.debit - cols.description - 36),
        cols.description,
        y,
      );
      ctx.textAlign = 'right';
      ctx.fillText(
        values.debit ? formatShopMoney(values.debit) : '',
        cols.debit,
        y,
      );
      ctx.fillText(
        values.credit ? formatShopMoney(values.credit) : '',
        cols.credit,
        y,
      );
      ctx.fillText(formatShopMoney(values.balance), cols.balance, y);
      ctx.textAlign = 'left';
    }
    y += ROW;
    const items = values?.items ?? [];
    if (items.length > 0) {
      ctx.font = canvasFont(meta.lang, 400, 15);
      ctx.fillStyle = CANVAS.muted;
      for (const item of items) {
        const detail = `${item.name} × ${qtyCsv(item.qtyMilli)} — ${formatShopMoney(item.amount)}`;
        ctx.fillText(
          fitText(ctx, detail, cols.debit - cols.description - 54),
          cols.description + 18,
          y,
        );
        y += ITEM_ROW;
      }
      y += ITEM_GAP;
      ctx.fillStyle = CANVAS.ink;
    }
  };
  if (extras) drawRow(null, 0);
  meta.rows.forEach((values, index) => {
    drawRow(values, index + extras);
  });
  ctx.strokeStyle = CANVAS.rule;
  ctx.beginPath();
  ctx.moveTo(MARGIN, y - 14);
  ctx.lineTo(WIDTH - MARGIN, y - 14);
  ctx.stroke();

  // Closing balance band and footer.
  const closingY = y + 34;
  ctx.fillStyle = CANVAS.ink;
  ctx.font = canvasFont(meta.lang, 700, 18);
  ctx.fillText(meta.labels.closing, cols.description, closingY);
  ctx.fillStyle = CANVAS.primary;
  ctx.font = canvasFont(meta.lang, 700, 26);
  ctx.textAlign = 'right';
  ctx.fillText(formatShopMoney(closingBalance), cols.balance, closingY + 2);
  ctx.textAlign = 'left';

  const footerY = Math.max(closingY + 100, height - 52);
  ctx.strokeStyle = CANVAS.rule;
  ctx.beginPath();
  ctx.moveTo(MARGIN, footerY - 24);
  ctx.lineTo(WIDTH - MARGIN, footerY - 24);
  ctx.stroke();
  ctx.fillStyle = CANVAS.muted;
  ctx.font = canvasFont(meta.lang, 400, 14);
  ctx.fillText(meta.labels.generatedBy, MARGIN, footerY);
  ctx.textAlign = 'right';
  ctx.fillText(meta.labels.asOf, WIDTH - MARGIN, footerY);
  ctx.textAlign = 'left';
  return canvas;
}

export async function statementPng(meta: StatementFileMeta): Promise<Blob> {
  return canvasBlob(await draw(meta), 'image/png');
}

export async function statementPdf(meta: StatementFileMeta): Promise<Blob> {
  const canvas = await draw(meta);
  const jpeg = new Uint8Array(
    await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
  );
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height, 210);
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
