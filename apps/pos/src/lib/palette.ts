/**
 * Colours used outside CSS: exported canvas files and the browser chrome. They mirror the
 * tokens in styles/tokens.css but stay literal because canvas and the meta tag cannot read
 * a CSS custom property reliably. Keep this list minimal and in sync with the tokens.
 */
export const CANVAS = {
  paper: '#ffffff',
  ink: '#0f172a',
  muted: '#475569',
  rule: '#cbd5e1',
  surface2: '#f1f5f9',
  primary: '#006bb3',
  success: '#047857',
} as const;

export const BROWSER_CHROME = {
  light: '#006bb3',
  dark: '#0f172a',
} as const;
