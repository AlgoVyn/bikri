import { canvasBlob, jpegToPdf } from '../print/receiptImage.ts';

export type StatementFileRow = {
  date: string;
  description: string;
  debit: number;
  credit: number;
  balance: number;
};

export type StatementFileMeta = {
  shopName: string;
  customerName: string;
  phone: string;
  balance: number;
  from: string | null;
  to: string | null;
  rows: readonly StatementFileRow[];
  openingBalance: number;
  labels: {
    title: string;
    date: string;
    description: string;
    debit: string;
    credit: string;
    balance: string;
    opening: string;
    total: string;
    asOf: string;
  };
};

const WIDTH = 1240;
const MARGIN = 60;
const ROW = 34;

/** A4-ish statement picture, built locally (no network) for PDF / share (screens/12 AC 7). */
function draw(meta: StatementFileMeta): HTMLCanvasElement {
  const extras = meta.openingBalance !== 0 ? 1 : 0;
  const height = 280 + (meta.rows.length + extras) * ROW + 80;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not available');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 38px Inter, sans-serif';
  ctx.fillText(meta.shopName, MARGIN, 70);
  ctx.font = 'bold 28px Inter, sans-serif';
  ctx.fillText(meta.labels.title, MARGIN, 120);
  ctx.font = '22px Inter, sans-serif';
  ctx.fillText(
    `${meta.customerName}${meta.phone ? ` · ${meta.phone}` : ''}`,
    MARGIN,
    158,
  );
  ctx.fillText(meta.labels.balance, MARGIN, 194);
  ctx.font = 'bold 24px Inter, sans-serif';
  ctx.fillText(
    `Rs ${(meta.balance / 100).toLocaleString('en-PK')}`,
    MARGIN + ctx.measureText(meta.labels.balance).width + 12,
    194,
  );
  ctx.font = '18px Inter, sans-serif';
  ctx.fillStyle = '#475569';
  ctx.fillText(meta.labels.asOf, MARGIN, 228);
  ctx.fillStyle = '#0f172a';

  const headerY = 270;
  const cols = {
    date: MARGIN,
    description: MARGIN + 160,
    debit: 820,
    credit: 950,
    balance: 1120,
  };
  ctx.font = 'bold 20px Inter, sans-serif';
  ctx.fillText(meta.labels.date, cols.date, headerY);
  ctx.fillText(meta.labels.description, cols.description, headerY);
  ctx.textAlign = 'right';
  ctx.fillText(meta.labels.debit, cols.debit, headerY);
  ctx.fillText(meta.labels.credit, cols.credit, headerY);
  ctx.fillText(meta.labels.balance, cols.balance, headerY);
  ctx.textAlign = 'left';
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(MARGIN, headerY + 10);
  ctx.lineTo(WIDTH - MARGIN, headerY + 10);
  ctx.stroke();

  let y = headerY + 44;
  const row = (values: StatementFileRow | null) => {
    ctx.font = '19px Inter, sans-serif';
    if (!values) {
      ctx.fillText(meta.labels.opening, cols.date, y);
      ctx.textAlign = 'right';
      ctx.fillText(
        `Rs ${(meta.openingBalance / 100).toLocaleString('en-PK')}`,
        cols.balance,
        y,
      );
      ctx.textAlign = 'left';
      y += ROW;
      return;
    }
    ctx.fillText(values.date, cols.date, y);
    const text =
      values.description.length > 46
        ? `${values.description.slice(0, 45)}…`
        : values.description;
    ctx.fillText(text, cols.description, y);
    ctx.textAlign = 'right';
    ctx.fillText(
      values.debit ? `Rs ${(values.debit / 100).toLocaleString('en-PK')}` : '',
      cols.debit,
      y,
    );
    ctx.fillText(
      values.credit
        ? `Rs ${(values.credit / 100).toLocaleString('en-PK')}`
        : '',
      cols.credit,
      y,
    );
    ctx.fillText(
      `Rs ${(values.balance / 100).toLocaleString('en-PK')}`,
      cols.balance,
      y,
    );
    ctx.textAlign = 'left';
    y += ROW;
  };
  if (extras) row(null);
  for (const values of meta.rows) row(values);
  ctx.font = 'bold 20px Inter, sans-serif';
  ctx.fillText(meta.labels.total, cols.description, y + 10);
  ctx.textAlign = 'right';
  ctx.fillText(
    `Rs ${(meta.balance / 100).toLocaleString('en-PK')}`,
    cols.balance,
    y + 10,
  );
  return canvas;
}

export async function statementPng(meta: StatementFileMeta): Promise<Blob> {
  return canvasBlob(draw(meta), 'image/png');
}

export async function statementPdf(meta: StatementFileMeta): Promise<Blob> {
  const canvas = draw(meta);
  const jpeg = new Uint8Array(
    await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
  );
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height, 210);
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
