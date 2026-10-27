/**
 * Receipt as a picture (06 §1 "share", screens/07 AC 2): the same laid-out lines the thermal
 * printer gets, drawn on a canvas `dots` wide in the receipt fonts, with the shop logo on top.
 * PNG for WhatsApp / Web Share; a one-page PDF (the JPEG of the same canvas) for Download PDF.
 */
import {
  type Block,
  type ItemLayout,
  layOut,
  lineNeedsRtl,
  prepareLogo,
  type RasterSource,
} from '@bikri/printer';

export type ImageOptions = {
  dots: number;
  charsPerLine: number;
  itemLayout: ItemLayout;
  logo: RasterSource | null;
};

const PAD = 16;
const MONO = "'JetBrains Mono', ui-monospace, monospace";
const URDU = "'Noto Nastaliq Urdu', serif";

type Row =
  | {
      kind: 'text';
      text: string;
      align: string;
      bold: boolean;
      size: string;
      height: number;
    }
  | { kind: 'raster'; source: RasterSource; height: number }
  | { kind: 'gap'; height: number };

/** Lines and heights in CSS pixels; exported for tests. */
export function receiptRows(blocks: Block[], options: ImageOptions): Row[] {
  const font = options.dots / (options.charsPerLine * 0.6);
  const line = Math.round(font * 1.35);
  const rows: Row[] = [];
  for (const c of layOut(blocks, {
    charsPerLine: options.charsPerLine,
    itemLayout: options.itemLayout,
  })) {
    switch (c.kind) {
      case 'text': {
        const size = c.size ?? 'normal';
        const rtl = lineNeedsRtl(c.text);
        const scale = size === 'small' ? 0.75 : size === 'normal' ? 1 : 2;
        rows.push({
          kind: 'text',
          text: c.text,
          align: rtl ? 'right' : (c.align ?? 'left'),
          bold: c.bold ?? false,
          size,
          height: Math.round(line * scale * (rtl ? 1.4 : 1)),
        });
        break;
      }
      case 'logo':
        if (options.logo) {
          const source = prepareLogo(options.logo, options.dots);
          rows.push({ kind: 'raster', source, height: source.height + 8 });
        }
        break;
      case 'image':
        rows.push({
          kind: 'raster',
          source: c.source.source,
          height: c.source.source.height,
        });
        break;
      case 'feed':
        rows.push({ kind: 'gap', height: line * c.lines });
        break;
      case 'qr':
        rows.push({
          kind: 'text',
          text: c.data,
          align: 'center',
          bold: false,
          size: 'small',
          height: Math.round(line * 0.75),
        });
        break;
      default:
        break; // cut and drawer have no picture
    }
  }
  return rows;
}

function toImageData(
  ctx: CanvasRenderingContext2D,
  source: RasterSource,
): ImageData {
  const out = ctx.createImageData(source.width, source.height);
  for (let i = 0; i < source.width * source.height; i += 1) {
    const v = source.format === 'gray' ? (source.data[i] ?? 255) : null;
    out.data[i * 4] = v ?? source.data[i * 4] ?? 255;
    out.data[i * 4 + 1] = v ?? source.data[i * 4 + 1] ?? 255;
    out.data[i * 4 + 2] = v ?? source.data[i * 4 + 2] ?? 255;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/** Draws the receipt; the canvas is `dots + 32` px wide. */
export async function renderReceiptCanvas(
  blocks: Block[],
  options: ImageOptions,
  doc: Document = document,
): Promise<HTMLCanvasElement> {
  await doc.fonts?.ready;
  const rows = receiptRows(blocks, options);
  const font = options.dots / (options.charsPerLine * 0.6);
  const canvas = doc.createElement('canvas');
  canvas.width = options.dots + PAD * 2;
  canvas.height = rows.reduce((h, r) => h + r.height, 0) + PAD * 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'top';
  let y = PAD;
  for (const row of rows) {
    if (row.kind === 'raster') {
      const x =
        PAD + Math.max(0, Math.floor((options.dots - row.source.width) / 2));
      ctx.putImageData(toImageData(ctx, row.source), x, y);
    } else if (row.kind === 'text') {
      const rtl = lineNeedsRtl(row.text);
      const px =
        font * (row.size === 'small' ? 0.75 : row.size === 'double' ? 2 : 1);
      ctx.save();
      ctx.font = `${row.bold ? 700 : 400} ${px}px ${rtl ? URDU : MONO}`;
      ctx.direction = rtl ? 'rtl' : 'ltr';
      ctx.textAlign =
        row.align === 'center'
          ? 'center'
          : row.align === 'right'
            ? 'right'
            : 'left';
      const x =
        row.align === 'center'
          ? PAD + options.dots / 2
          : row.align === 'right'
            ? PAD + options.dots
            : PAD;
      if (row.size === 'double-height') {
        ctx.translate(0, y);
        ctx.scale(1, 2);
        ctx.fillText(rtl ? row.text.trim() : row.text, x, 0);
      } else ctx.fillText(rtl ? row.text.trim() : row.text, x, y);
      ctx.restore();
    }
    y += row.height;
  }
  return canvas;
}

export function canvasBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('toBlob failed'))),
      type,
      quality,
    );
  });
}

/**
 * Minimal one-page PDF that shows a JPEG at the receipt's paper width
 * (no PDF library: catalog, pages, page, content stream, DCT image).
 */
export function jpegToPdf(
  jpeg: Uint8Array,
  width: number,
  height: number,
  widthMm: number,
): Uint8Array {
  const enc = new TextEncoder();
  const wPt = (widthMm / 25.4) * 72;
  const hPt = (wPt * height) / width;
  const f = (n: number) => n.toFixed(2);
  const content = `q ${f(wPt)} 0 0 ${f(hPt)} 0 0 cm /Im0 Do Q`;
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (chunk: string | Uint8Array) => {
    const bytes = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const obj = (n: number, body: string) => {
    offsets[n] = length;
    push(`${n} 0 obj\n${body}\nendobj\n`);
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    3,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(wPt)} ${f(hPt)}] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
  );
  obj(4, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  offsets[5] = length;
  push(
    `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
  );
  push(jpeg);
  push('\nendstream\nendobj\n');
  const xref = length;
  const rows = [1, 2, 3, 4, 5].map(
    (n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`,
  );
  push(
    `xref\n0 6\n0000000000 65535 f \n${rows.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Saves a blob through a temporary link (the browser's download). */
export function downloadBlob(
  blob: Blob,
  filename: string,
  doc: Document = document,
): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Gray/RGBA bitmap as a PNG data URL (logo for system printing). */
export function bitmapDataUrl(
  source: RasterSource,
  doc: Document = document,
): string | null {
  const canvas = doc.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.putImageData(toImageData(ctx, source), 0, 0);
  return canvas.toDataURL('image/png');
}
