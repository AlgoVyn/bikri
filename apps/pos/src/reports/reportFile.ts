import { formatMoney } from '@bikri/core';
import type { ReportBundle } from '../data/reportBundle.ts';
import { canvasBlob, jpegToPdf } from '../print/receiptImage.ts';
import { shortDate } from './format.ts';

export type ReportFileLabels = {
  title: string;
  range: string;
  generated: string;
  sold: string;
  bills: string;
  avgBill: string;
  grossProfit: string;
  expenses: string;
  netProfit: string;
  margin: string;
  tax: string;
  paymentMix: string;
  chartSold: string;
  chartProfit: string;
  udhaarGiven: string;
  udhaarReceived: string;
  methods: { cash: string; card: string; bank_wallet: string; udhaar: string };
};

export type ReportFileMeta = {
  shopName: string;
  from: string;
  to: string;
  generatedAt: number;
  lang: string;
  showProfit: boolean;
  labels: ReportFileLabels;
  bundle: ReportBundle;
};

const WIDTH = 1240;
const MARGIN = 60;

function draw(meta: ReportFileMeta): HTMLCanvasElement {
  const { bundle, labels } = meta;
  const summary = bundle.summary;
  const days = summary.daily.length;
  const chartHeight = 300;
  const height = 420 + chartHeight + 220;
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas not available');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, WIDTH, height);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 40px Inter, sans-serif';
  ctx.fillText(meta.shopName, MARGIN, 70);
  ctx.font = 'bold 28px Inter, sans-serif';
  ctx.fillText(labels.title, MARGIN, 132);
  ctx.font = '20px Inter, sans-serif';
  ctx.fillStyle = '#475569';
  ctx.fillText(
    `${labels.range}: ${shortDate(meta.from, meta.lang)} – ${shortDate(meta.to, meta.lang)}`,
    MARGIN,
    168,
  );
  ctx.fillText(
    `${labels.generated}: ${new Intl.DateTimeFormat('en-PK', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Karachi',
    }).format(meta.generatedAt)}`,
    MARGIN,
    198,
  );

  const cards = [
    [labels.sold, formatMoney(summary.sold)],
    [labels.bills, String(summary.bills)],
    [labels.avgBill, formatMoney(summary.avgBill)],
    ...(meta.showProfit
      ? [
          [labels.grossProfit, formatMoney(summary.grossProfit)],
          [labels.expenses, formatMoney(summary.expenses)],
          [labels.netProfit, formatMoney(summary.netProfit)],
        ]
      : [[labels.expenses, formatMoney(summary.expenses)]]),
    ...(summary.tax !== 0 ? [[labels.tax, formatMoney(summary.tax)]] : []),
    ...(meta.showProfit
      ? [[labels.margin, `${(summary.marginBp / 100).toFixed(1)}%`]]
      : []),
  ] as [string, string][];
  const cardWidth = (WIDTH - MARGIN * 2 - 30) / 4;
  cards.forEach(([label, value], index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const x = MARGIN + column * (cardWidth + 10);
    const y = 240 + row * 86;
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(x, y, cardWidth, 72);
    ctx.fillStyle = '#475569';
    ctx.font = '16px Inter, sans-serif';
    ctx.fillText(label, x + 14, y + 26);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 22px Inter, sans-serif';
    ctx.fillText(value, x + 14, y + 56);
  });

  const chartTop = 240 + Math.ceil(cards.length / 4) * 86 + 30;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px Inter, sans-serif';
  ctx.fillText(
    meta.showProfit
      ? `${labels.chartSold} / ${labels.chartProfit}`
      : labels.chartSold,
    MARGIN,
    chartTop,
  );
  const values = summary.daily.flatMap((day) =>
    meta.showProfit ? [day.sold, day.grossProfit] : [day.sold],
  );
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const chartX = MARGIN;
  const chartY = chartTop + 20;
  const chartW = WIDTH - MARGIN * 2;
  const barW = Math.max(1, Math.min(14, chartW / Math.max(1, days) - 1));
  const zero = chartY + ((max - 0) / span) * chartHeight;
  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(chartX, zero);
  ctx.lineTo(chartX + chartW, zero);
  ctx.stroke();
  summary.daily.forEach((day, index) => {
    const x =
      chartX + (days === 1 ? chartW / 2 : (index / (days - 1)) * chartW);
    const y = chartY + ((max - day.sold) / span) * chartHeight;
    ctx.fillStyle = '#006bb3';
    if (day.sold >= 0) {
      ctx.fillRect(x - barW / 2, y, barW, Math.max(0, zero - y));
    } else {
      ctx.fillRect(x - barW / 2, zero, barW, Math.max(0, y - zero));
    }
  });
  if (meta.showProfit) {
    ctx.strokeStyle = '#047857';
    ctx.lineWidth = 2;
    ctx.beginPath();
    summary.daily.forEach((day, index) => {
      const x =
        chartX + (days === 1 ? chartW / 2 : (index / (days - 1)) * chartW);
      const y = chartY + ((max - day.grossProfit) / span) * chartHeight;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.lineWidth = 1;
  }
  if (summary.daily.length > 0) {
    ctx.fillStyle = '#475569';
    ctx.font = '14px Inter, sans-serif';
    const first = summary.daily[0];
    const last = summary.daily.at(-1);
    if (first)
      ctx.fillText(
        shortDate(first.date, meta.lang),
        chartX,
        chartY + chartHeight + 22,
      );
    if (last) {
      const label = shortDate(last.date, meta.lang);
      ctx.fillText(
        label,
        chartX + chartW - ctx.measureText(label).width,
        chartY + chartHeight + 22,
      );
    }
  }

  const mixTop = chartY + chartHeight + 56;
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 22px Inter, sans-serif';
  ctx.fillText(labels.paymentMix, MARGIN, mixTop);
  ctx.font = '18px Inter, sans-serif';
  const methods = [
    [labels.methods.cash, summary.paymentMix.cash],
    [labels.methods.card, summary.paymentMix.card],
    [labels.methods.bank_wallet, summary.paymentMix.bank_wallet],
    [labels.methods.udhaar, summary.paymentMix.udhaar],
  ] as const;
  methods.forEach(([label, value], index) => {
    const x = MARGIN + index * 280;
    const y = mixTop + 34;
    ctx.fillStyle = '#475569';
    ctx.fillText(label, x, y);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 18px Inter, sans-serif';
    ctx.fillText(formatMoney(value), x, y + 26);
    ctx.font = '18px Inter, sans-serif';
  });
  ctx.fillStyle = '#475569';
  ctx.fillText(
    `${labels.udhaarGiven}: ${formatMoney(summary.udhaarGiven)}   ·   ${labels.udhaarReceived}: ${formatMoney(summary.udhaarReceived)}`,
    MARGIN,
    mixTop + 92,
  );
  return canvas;
}

export async function reportPng(meta: ReportFileMeta): Promise<Blob> {
  return canvasBlob(draw(meta), 'image/png');
}

export async function reportPdf(meta: ReportFileMeta): Promise<Blob> {
  const canvas = draw(meta);
  const jpeg = new Uint8Array(
    await (await canvasBlob(canvas, 'image/jpeg', 0.92)).arrayBuffer(),
  );
  const pdf = jpegToPdf(jpeg, canvas.width, canvas.height, 210);
  return new Blob([pdf as BlobPart], { type: 'application/pdf' });
}
