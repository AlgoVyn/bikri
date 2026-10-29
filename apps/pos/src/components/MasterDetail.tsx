import type { ReactNode } from 'react';

/**
 * Reference-style master–detail workspace (screens 08/10/12/13). On ≥1024 px the list stays on
 * the start side and the selected row's detail fills the end side; on phones only one is shown.
 */
export function MasterDetail({
  master,
  detail,
  placeholder,
  showDetail,
  masterTestId,
  detailTestId,
}: {
  master: ReactNode;
  detail?: ReactNode;
  placeholder: ReactNode;
  showDetail: boolean;
  masterTestId?: string;
  detailTestId?: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1720px] flex-col gap-4 p-4 lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:items-start lg:gap-6 lg:p-6">
      <div
        className={showDetail ? 'min-w-0 max-lg:hidden' : 'min-w-0'}
        data-testid={masterTestId}
      >
        {master}
      </div>
      <div
        className={showDetail ? 'min-w-0' : 'hidden min-w-0 lg:block'}
        data-testid={detailTestId}
      >
        {showDetail ? detail : placeholder}
      </div>
    </div>
  );
}

export function MasterPlaceholder({
  icon,
  title,
  hint,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex min-h-[26rem] flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border-strong bg-surface-2/40 p-8 text-center">
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-surface text-text-muted"
      >
        {icon}
      </span>
      <p className="text-title font-semibold">{title}</p>
      <p className="max-w-xs text-small text-text-muted">{hint}</p>
    </div>
  );
}
