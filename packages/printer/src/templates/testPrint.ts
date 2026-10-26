import { paperRuler } from '../layout.ts';
import type { Block } from '../types.ts';
import { labelsFrom, pushJobEnd } from './common.ts';
import type { ReceiptLabels } from './types.ts';

export type TestPrintInput = {
  charsPerLine: number;
  labels?: Partial<ReceiptLabels>;
  /** Default on. The encoder skips it when no bitmap is supplied. */
  printLogo?: boolean;
  /** Default on, matching the printer setting. */
  drawer?: boolean;
};

/** 06 §4.3 / §8 test page: ruler, bold, double, Urdu raster line, QR, cut, drawer. */
export function buildTestPrint(input: TestPrintInput): Block[] {
  const labels = labelsFrom(input.labels);
  const blocks: Block[] = [];
  if (input.printLogo !== false) {
    blocks.push({ t: 'logo' });
  }
  blocks.push({
    t: 'text',
    text: labels.testTitle,
    align: 'center',
    bold: true,
  });
  blocks.push({ t: 'rule', char: '-' });
  blocks.push({ t: 'text', text: paperRuler(input.charsPerLine) });
  blocks.push({
    t: 'text',
    text: labels.boldSample,
    align: 'center',
    bold: true,
  });
  blocks.push({
    t: 'text',
    text: labels.doubleSample,
    align: 'center',
    bold: true,
    size: 'double',
  });
  blocks.push({
    t: 'text',
    text: labels.urduSample,
    align: 'center',
  });
  blocks.push({ t: 'qr', data: 'bikri-test-print' });
  blocks.push({
    t: 'text',
    text: labels.drawerWorks,
    align: 'center',
  });
  pushJobEnd(blocks, input.drawer !== false);
  return blocks;
}
