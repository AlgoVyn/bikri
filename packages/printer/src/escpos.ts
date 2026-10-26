import {
  hasNonAscii,
  type ItemLayout,
  type LaidCommand,
  type LaidText,
  layOut,
  lineNeedsRtl,
} from './layout.ts';
import {
  encodeGsV0,
  fitRasterToDots,
  packMono,
  prepareLogo,
} from './raster.ts';
import type {
  Block,
  CutMode,
  RasterRenderer,
  RasterSource,
  ReceiptLanguage,
  TextSize,
} from './types.ts';

export type EncodeOptions = {
  charsPerLine: number;
  dots: number;
  /**
   * How `item` blocks are broken. Defaults to columns at 40+ characters.
   * Pass `resolvePaper().itemLayout` so 58 mm stays stacked even if chars are overridden.
   */
  itemLayout?: ItemLayout;
  /** Default partial (`1D 56 42 00`). `none` drops the cut command. */
  cut?: CutMode;
  /** Default pin 2 (`1B 70 00 19 FA`). */
  drawerPin?: 2 | 5;
  /** `ur` rasterises every text line. `en` and `roman-ur` rasterise non-ASCII only. */
  language?: ReceiptLanguage;
  renderer?: RasterRenderer;
  /** Greyscale or RGBA logo. Scaled, dithered, and centered. Omitted if null. */
  logo?: RasterSource | null;
  /** Default 6 when dots >= 512, otherwise 4. */
  qrModuleSize?: number;
};

type Style = {
  align: LaidText['align'];
  bold: boolean;
  size: TextSize;
};

const INITIAL_STYLE: Style = { align: 'left', bold: false, size: 'normal' };

class ByteBuf {
  private readonly chunks: Uint8Array[] = [];

  push(...bytes: number[]): void {
    this.chunks.push(Uint8Array.from(bytes));
  }

  append(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  ascii(text: string): void {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i) ?? 0;
      if (code < 32 || code > 126) {
        throw new Error(`non-ASCII in text mode: U+${code.toString(16)}`);
      }
      bytes[i] = code;
    }
    this.append(bytes);
  }

  toUint8Array(): Uint8Array {
    const length = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function sizeByte(size: TextSize): number {
  if (size === 'double') {
    return 0x11;
  }
  if (size === 'double-height') {
    return 0x01;
  }
  return 0x00;
}

function alignByte(align: Style['align']): number {
  if (align === 'center') {
    return 1;
  }
  if (align === 'right') {
    return 2;
  }
  return 0;
}

/** 6 on 80 mm / 512-dot overrides, 4 on 58 mm. */
export function qrModuleSizeFor(dots: number): number {
  return dots >= 512 ? 6 : 4;
}

function pushFeed(buf: ByteBuf, lines: number): void {
  let left = lines;
  while (left > 0) {
    const n = Math.min(255, left);
    buf.push(0x1b, 0x64, n);
    left -= n;
  }
}

function pushCut(buf: ByteBuf, cut: CutMode): void {
  if (cut === 'none') {
    return;
  }
  if (cut === 'full') {
    buf.push(0x1d, 0x56, 0x41, 0x00);
    return;
  }
  buf.push(0x1d, 0x56, 0x42, 0x00);
}

function pushDrawer(buf: ByteBuf, pin: 2 | 5): void {
  buf.push(0x1b, 0x70, pin === 5 ? 0x01 : 0x00, 0x19, 0xfa);
}

function pushQr(buf: ByteBuf, data: string, moduleSize: number): void {
  if (moduleSize < 1 || moduleSize > 16 || !Number.isInteger(moduleSize)) {
    throw new Error('QR module size must be an integer from 1 to 16');
  }
  const payload: number[] = [];
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i) ?? 0;
    if (code > 127) {
      throw new Error('QR data must be ASCII');
    }
    payload.push(code);
  }
  const storeLength = payload.length + 3;
  if (storeLength > 65535) {
    throw new Error('QR data is too long');
  }
  buf.push(
    0x1d,
    0x28,
    0x6b,
    0x04,
    0x00,
    0x31,
    0x41,
    0x32,
    0x00,
    0x1d,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x43,
    moduleSize,
    0x1d,
    0x28,
    0x6b,
    0x03,
    0x00,
    0x31,
    0x45,
    0x31,
    0x1d,
    0x28,
    0x6b,
    storeLength & 0xff,
    (storeLength >> 8) & 0xff,
    0x31,
    0x50,
    0x30,
  );
  buf.append(Uint8Array.from(payload));
  buf.push(0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);
}

function requireRenderer(renderer: RasterRenderer | undefined): RasterRenderer {
  if (renderer === undefined) {
    throw new Error('RasterRenderer is required for Urdu or non-ASCII lines');
  }
  return renderer;
}

/**
 * Encode blocks to ESC/POS. Every job starts with `1B 40` and code page
 * PC437 `1B 74 00`. Align, bold, and size are sent only when they change.
 * Raster rows use `GS v 0` (`1D 76 30 00`).
 */
export function encodeEscPos(
  blocks: Block[],
  options: EncodeOptions,
): Uint8Array {
  if (!Number.isInteger(options.dots) || options.dots < 1) {
    throw new Error('dots must be a positive integer');
  }
  const pin = (options.drawerPin ?? 2) as number;
  if (pin !== 2 && pin !== 5) {
    throw new Error('drawer pin must be 2 or 5');
  }
  const commands = layOut(blocks, {
    charsPerLine: options.charsPerLine,
    itemLayout:
      options.itemLayout ?? (options.charsPerLine < 40 ? 'stacked' : 'columns'),
  });
  return encodeCommands(commands, {
    dots: options.dots,
    cut: options.cut ?? 'partial',
    pin,
    imageMode: (options.language ?? 'en') === 'ur',
    moduleSize: options.qrModuleSize ?? qrModuleSizeFor(options.dots),
    renderer: options.renderer,
    logo: options.logo ?? null,
  });
}

type EncodeState = {
  dots: number;
  cut: CutMode;
  pin: 2 | 5;
  imageMode: boolean;
  moduleSize: number;
  renderer: RasterRenderer | undefined;
  logo: RasterSource | null;
};

function encodeCommands(
  commands: LaidCommand[],
  state: EncodeState,
): Uint8Array {
  const buf = new ByteBuf();
  buf.push(0x1b, 0x40, 0x1b, 0x74, 0x00);
  let style = { ...INITIAL_STYLE };

  const applyStyle = (next: Style): void => {
    if (style.align !== next.align) {
      buf.push(0x1b, 0x61, alignByte(next.align));
      style = { ...style, align: next.align };
    }
    if (style.bold !== next.bold) {
      buf.push(0x1b, 0x45, next.bold ? 0x01 : 0x00);
      style = { ...style, bold: next.bold };
    }
    if (style.size !== next.size) {
      buf.push(0x1d, 0x21, sizeByte(next.size));
      style = { ...style, size: next.size };
    }
  };

  const resetStyle = (): void => {
    applyStyle(INITIAL_STYLE);
  };

  const writeRaster = (packed: ReturnType<typeof packMono>): void => {
    resetStyle();
    buf.append(encodeGsV0(packed));
  };

  for (const command of commands) {
    switch (command.kind) {
      case 'text': {
        const raster = state.imageMode || hasNonAscii(command.text);
        if (raster) {
          const renderer = requireRenderer(state.renderer);
          const rendered = renderer.renderLine(command.text, {
            dots: state.dots,
            align: command.align,
            bold: command.bold,
            size: command.size,
            rtl: lineNeedsRtl(command.text),
          });
          writeRaster(
            packMono(fitRasterToDots(rendered, state.dots), 'threshold'),
          );
          break;
        }
        applyStyle({
          align: command.align,
          bold: command.bold,
          size: command.size,
        });
        buf.ascii(command.text);
        buf.push(0x0a);
        break;
      }
      case 'logo': {
        if (state.logo === null) {
          break;
        }
        writeRaster(packMono(prepareLogo(state.logo, state.dots), 'dither'));
        break;
      }
      case 'image': {
        const fitted = command.source.source;
        const mode = command.source.dither === true ? 'dither' : 'threshold';
        writeRaster(packMono(fitted, mode));
        break;
      }
      case 'qr':
        applyStyle({ align: 'center', bold: false, size: 'normal' });
        pushQr(buf, command.data, state.moduleSize);
        break;
      case 'feed':
        pushFeed(buf, command.lines);
        break;
      case 'cut':
        pushCut(buf, state.cut);
        break;
      case 'drawer':
        pushDrawer(buf, state.pin);
        break;
      default: {
        const unreachable: never = command;
        return unreachable;
      }
    }
  }
  return buf.toUint8Array();
}
