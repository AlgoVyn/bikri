/** Static class names so Tailwind generates every tile swatch (08 §2). */
export const TILE_BG: Record<string, string> = {
  t1: 'bg-t1',
  t2: 'bg-t2',
  t3: 'bg-t3',
  t4: 'bg-t4',
  t5: 'bg-t5',
  t6: 'bg-t6',
  t7: 'bg-t7',
  t8: 'bg-t8',
};

export const tileBg = (color: unknown) => TILE_BG[String(color)] ?? 'bg-t8';
