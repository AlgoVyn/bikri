/** Golden-file helpers for tests: bytes as 16-per-line hex so diffs stay readable. */
export function toHexLines(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    lines.push(
      Array.from(bytes.subarray(i, i + 16), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join(' '),
    );
  }
  return `${lines.join('\n')}\n`;
}

export function fromHexLines(hex: string): Uint8Array {
  const parts = hex.split(/\s+/).filter((p) => p.length > 0);
  return Uint8Array.from(parts, (p) => {
    const n = Number.parseInt(p, 16);
    if (!/^[0-9a-f]{2}$/.test(p) || Number.isNaN(n)) {
      throw new Error(`bad hex byte '${p}'`);
    }
    return n;
  });
}
