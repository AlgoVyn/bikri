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
