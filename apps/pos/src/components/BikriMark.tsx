/**
 * The Bikri mark (D-216): an open ledger with a tick cut through both pages and a turquoise
 * total line beneath. Decorative beside the wordmark. The tick is a real cut-out, so it shows
 * whatever surface is behind the mark. Drawn from the small-size master (wider tick, heavier
 * total line) because the UI shows it at 24-40 px.
 *
 * `tone="auto"` follows the theme (navy book on light surfaces, near-white in dark mode);
 * `tone="reversed"` is for the always-navy rail and brand panels.
 */
export function BikriMark({
  className = 'size-7',
  tone = 'auto',
}: {
  className?: string;
  tone?: 'auto' | 'reversed';
}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 -4 128 128.4"
      className={`${className} shrink-0`}
      data-testid="bikri-mark"
    >
      <path
        className={tone === 'reversed' ? 'fill-rail-ink' : 'fill-brand-mark'}
        d="M72.74 9.55 116.74 0.13C118.51 -0.25 120.36 0.19 121.77 1.33C123.18 2.47 124 4.18 124 5.99V81.72C124 84.55 122.03 87 119.26 87.59L75.26 97.01C73.49 97.39 71.64 96.95 70.23 95.82C68.82 94.68 68 92.97 68 91.15V68.15L93.34 40.65C96.91 36.7 96.64 30.61 92.72 27C88.8 23.39 82.71 23.61 79.06 27.49L68 39.49V15.42C68 12.59 69.97 10.15 72.74 9.55ZM11.26 0.13 55.26 9.55C58.03 10.15 60 12.59 60 15.42V48.17L54.05 54.62L44.4 45.14C40.56 41.48 34.49 41.58 30.77 45.37C27.05 49.16 27.06 55.23 30.8 59L47.6 75.5C49.48 77.34 52.02 78.35 54.64 78.28C56.58 78.23 58.44 77.61 60 76.51V91.15C60 92.97 59.18 94.68 57.77 95.82C56.36 96.95 54.51 97.39 52.74 97.01L8.74 87.59C5.97 87 4 84.55 4 81.72V5.99C4 4.18 4.82 2.47 6.23 1.33C7.64 0.19 9.49 -0.25 11.26 0.13Z"
      />
      <path
        className="fill-accent"
        d="M6.23 95.05 63.79 107.38C63.93 107.41 64.07 107.41 64.21 107.38L121.77 95.05C123.29 94.73 124.88 95.11 126.09 96.08C127.29 97.06 128 98.53 128 100.08V101.46C128 104.53 125.86 107.17 122.86 107.81L64.21 120.38C64.07 120.41 63.93 120.41 63.79 120.38L5.14 107.81C2.14 107.17 0 104.53 0 101.46V100.08C0 98.53 0.71 97.06 1.91 96.08C3.12 95.11 4.71 94.73 6.23 95.05Z"
      />
    </svg>
  );
}
