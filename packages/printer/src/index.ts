/** Receipt layout and ESC/POS encoder (T-019). Transports are T-020. */
export const packageName = '@bikri/printer';

export { type EncodeOptions, encodeEscPos, qrModuleSizeFor } from './escpos.ts';
export { createFakeRasterRenderer } from './fakeRaster.ts';
export {
  calendarDaysBetween,
  fill,
  formatIsoDate,
  formatItemCount,
  formatReceiptDate,
  formatReceiptMoney,
  formatReceiptNumber,
  formatReceiptPhone,
  formatTaxRate,
} from './format.ts';
export {
  fitPageCss,
  type HtmlOptions,
  renderReceiptHtml,
} from './html.ts';
export {
  columnWidths,
  formatColumnHeader,
  formatItemLines,
  formatPair,
  hasNonAscii,
  type ItemFields,
  type ItemLayout,
  itemLayoutFor,
  type LaidCommand,
  type LaidText,
  type LayoutOptions,
  layOut,
  lineNeedsRtl,
  PAPER_PRESETS,
  type PaperMm,
  type PaperPreset,
  paperRuler,
  type ResolvedPaper,
  renderReceiptText,
  resolvePaper,
  wrapText,
} from './layout.ts';
export {
  centerOnWidth,
  encodeGsV0,
  fitRasterToDots,
  type PackedBitmap,
  packMono,
  prepareLogo,
  scaleToFit,
} from './raster.ts';
export {
  POWERED_BY,
  type TemplateSettings,
} from './templates/common.ts';
export { englishReceiptLabels, resolveLabels } from './templates/labels.ts';
export { buildRefundReceipt } from './templates/refund.ts';
export { buildSaleReceipt, type SaleReceiptInput } from './templates/sale.ts';
export { saleBasicInput } from './templates/saleBasicFixture.ts';
export { buildTestPrint, type TestPrintInput } from './templates/testPrint.ts';
export type {
  ReceiptLabels,
  ReceiptLine,
  ReceiptPayment,
  ReceiptSale,
  ReceiptShop,
  RefundLine,
  RefundReceipt,
} from './templates/types.ts';
export type {
  Align,
  Block,
  CutMode,
  Font,
  RasterFormat,
  RasterRenderer,
  RasterSource,
  ReceiptLanguage,
  RenderLineOptions,
  TextSize,
} from './types.ts';
