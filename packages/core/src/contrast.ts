const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function parseHex(hex: string): readonly [number, number, number] {
  const match = HEX.exec(hex.trim());
  if (match === null) {
    throw new Error(`Invalid hex colour: ${hex}`);
  }
  const body = match[1] ?? '';
  const full =
    body.length === 3
      ? [...body].map((channel) => channel + channel).join('')
      : body;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function linearize(channel: number): number {
  const srgb = channel / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  const [red, green, blue] = parseHex(hex);
  return (
    0.2126 * linearize(red) +
    0.7152 * linearize(green) +
    0.0722 * linearize(blue)
  );
}

/** WCAG 2.2 contrast ratio between two hex colours (order does not matter). */
export function contrastRatio(hexA: string, hexB: string): number {
  const first = relativeLuminance(hexA);
  const second = relativeLuminance(hexB);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}
