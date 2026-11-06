/** Canvas font stacks that contain shaping fonts for Urdu/Arabic labels. */
export const LATIN_FONT = 'Inter, sans-serif';
export const URDU_FONT = "'Noto Naskh Arabic UI', 'Noto Naskh Arabic', serif";

export function canvasFont(
  lang: string | undefined,
  weight: number | 'bold',
  px: number,
): string {
  return `${weight === 'bold' ? 700 : weight} ${px}px ${
    lang === 'ur' ? URDU_FONT : LATIN_FONT
  }`;
}

/** Canvas has no font-loading API; wait for the same fonts the DOM uses. */
export async function prepareCanvasFonts(
  lang: string | undefined,
): Promise<void> {
  if (lang !== 'ur' || typeof document === 'undefined') return;
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  await Promise.all([
    fonts.load(`400 24px ${URDU_FONT}`),
    fonts.load(`700 24px ${URDU_FONT}`),
  ]);
}
