import { BASE_PATH } from '@bikri/core';
import { LABEL_SIZES } from '@bikri/printer';
import type { LabelSettings } from '../settings/LabelsPage.ts';

export function printLabelHtml(
  labels: string[],
  settings: LabelSettings,
): void {
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
  const fontBase = `${window.location.origin}${BASE_PATH}/fonts`;
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
    @font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url("${fontBase}/inter-latin-wght-normal.woff2") format("woff2")}
    @font-face{font-family:"Noto Naskh Arabic UI";font-style:normal;font-weight:400 700;font-display:swap;src:url("${fontBase}/noto-naskh-arabic-arabic-wght-normal.woff2") format("woff2")}
    @font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:100 800;font-display:swap;src:url("${fontBase}/jetbrains-mono-latin-wght-normal.woff2") format("woff2")}
    *{box-sizing:border-box} body{margin:0;font-family:Inter,Arial,sans-serif;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    ${page}
    .sheet{${grid}}
    .label{${labelCss}display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.3mm;text-align:center}
    .shop{font-family:"Noto Naskh Arabic UI",Inter,Arial,sans-serif;font-size:7pt;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}
    .name{font-family:"Noto Naskh Arabic UI",Inter,Arial,sans-serif;font-size:8pt;font-weight:700;line-height:1.35;max-height:3.2em;overflow:hidden;width:100%}
    .price{font-size:10pt;font-weight:700;line-height:1.1}
    .bars{width:100%;display:flex;justify-content:center}
    .bars svg{display:block;max-width:100%;height:${size.barHeightMm}mm}
    .value{font-family:"JetBrains Mono",monospace;font-size:7pt;line-height:1.1;white-space:nowrap;max-width:100%;overflow:hidden}
  </style></head><body><div class="sheet">${skip}${labels.join('')}</div></body></html>`);
  doc.close();
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let removal: ReturnType<typeof setTimeout> | null = null;
  const cleanup = () => {
    if (removal !== null) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    // Some browsers fire afterprint as soon as print() returns, before the
    // spooler has read the sheet. Keep the hidden frame for a short grace period.
    removal = setTimeout(() => frame.remove(), 2_000);
  };
  const start = () => {
    win.addEventListener('afterprint', cleanup, { once: true });
    // Fallback for browsers that never fire afterprint; the sheet itself has
    // already been handed to the print dialog at that point.
    timer = setTimeout(cleanup, 60_000);
    try {
      win.focus();
      win.print();
    } catch {
      // Headless/embedded browsers can refuse window.print(); keep the frame
      // until the fallback timer so the sheet can still be inspected/printed.
    }
  };
  // The iframe loads its own @font-face rules; wait so the driver rasterises
  // the Urdu/Inter glyphs instead of a fallback font.
  const ready = doc.fonts?.ready ?? Promise.resolve();
  void ready.then(start, start);
}
