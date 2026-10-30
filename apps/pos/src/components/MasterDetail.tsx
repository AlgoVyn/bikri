import type { ReactNode } from 'react';

/**
 * Master–detail workspace (screens 08/10/12/13). Until a row is selected the list uses the
 * full width; on >=1280 the selected detail sits beside it and stays in view while the list scrolls.
 * Below 1280 only the list or the selected detail is shown.
 */
export function MasterDetail({
  master,
  detail,
  showDetail,
  masterTestId,
  detailTestId,
}: {
  master: ReactNode;
  detail?: ReactNode;
  showDetail: boolean;
  masterTestId?: string;
  detailTestId?: string;
}) {
  return (
    <div
      className={`mx-auto flex w-full max-w-[1720px] flex-col gap-4 p-4 xl:gap-6 xl:p-6 ${
        showDetail
          ? 'xl:grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] xl:items-start'
          : ''
      }`}
    >
      <div
        className={showDetail ? 'min-w-0 max-xl:hidden' : 'min-w-0'}
        data-testid={masterTestId}
      >
        {master}
      </div>
      {showDetail ? (
        <div
          className="min-w-0 xl:sticky xl:top-20 xl:max-h-[calc(100dvh-6rem)] xl:overflow-y-auto"
          data-testid={detailTestId}
        >
          {detail}
        </div>
      ) : null}
    </div>
  );
}
