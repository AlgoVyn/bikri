export const buttonPrimary =
  'inline-flex min-h-11 items-center justify-center rounded-control bg-primary px-4 font-medium text-primary-ink transition-colors duration-150 hover:bg-primary-hover active:bg-primary-hover disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-muted';

export const buttonDanger =
  'inline-flex min-h-11 items-center justify-center rounded-control bg-danger px-4 font-medium text-danger-ink transition-colors duration-150 hover:opacity-90 active:opacity-90 disabled:pointer-events-none disabled:bg-surface-2 disabled:text-text-muted';

export const buttonDangerQuiet =
  'inline-flex min-h-11 items-center justify-center rounded-control border border-danger bg-surface px-4 font-medium text-danger transition-colors duration-150 hover:bg-danger-subtle disabled:pointer-events-none disabled:border-border disabled:bg-surface-2 disabled:text-text-muted';

export const buttonQuiet =
  'inline-flex min-h-11 items-center justify-center rounded-control border border-border-strong bg-surface px-4 text-text transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2 disabled:pointer-events-none disabled:border-border disabled:bg-surface-2 disabled:text-text-muted';

/** Square 36 px quiet control for dense rows (cart steppers, label copies). */
export const buttonQuietDense =
  'inline-flex min-h-9 min-w-9 items-center justify-center rounded-control border border-border-strong bg-surface px-0 text-text transition-colors duration-150 hover:bg-surface-2 active:bg-surface-2 disabled:pointer-events-none disabled:border-border disabled:bg-surface-2 disabled:text-text-muted';

/** The standard card surface (settings sections, forms, list panels). */
export const cardClass = 'rounded-card border border-border bg-surface';

export const fieldClass =
  'h-11 w-full rounded-control border border-border-strong bg-surface px-3 font-mono text-body text-text outline-none transition-colors duration-150 focus:border-primary';

/**
 * Page containers (docs/08 §2 — Layout containers). A screen picks one width by its job;
 * it never invents its own max-width. MasterDetail owns the workspace width itself.
 */
export type PageWidth = 'focused' | 'standard' | 'wide' | 'workspace';

const PAGE_WIDTH: Record<PageWidth, string> = {
  focused: 'max-w-[896px]',
  standard: 'max-w-[1152px]',
  wide: 'max-w-[1440px]',
  workspace: 'max-w-[1720px]',
};

export function pageClass(
  width: PageWidth = 'standard',
  gap: 'gap-3' | 'gap-4' | 'gap-6' = 'gap-3',
): string {
  return `mx-auto flex w-full ${PAGE_WIDTH[width]} flex-col ${gap} p-4 xl:p-6`;
}
