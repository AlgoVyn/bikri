import { createCanvasRasterRenderer } from './canvasRaster.ts';
import type { PrintDeps } from './printService.ts';
import { bitmapDataUrl } from './receiptImage.ts';
import { webSerial, webUsb } from './transports.ts';

let deps: PrintDeps | null = null;

/** Transports and rasteriser of this browser. */
export function browserPrintDeps(): PrintDeps {
  deps ??= {
    usb: webUsb(),
    serial: webSerial(),
    renderer: createCanvasRasterRenderer(),
    logoUrl: (logo) => bitmapDataUrl(logo),
  };
  return deps;
}
