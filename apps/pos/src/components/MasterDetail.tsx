import { type ReactNode, useLayoutEffect, useRef } from 'react';
import { takeListScroll } from '../lib/listScroll.ts';

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
  const masterRef = useRef<HTMLDivElement>(null);

  // List rows keep the page scroll (resetScroll={false}) so desktop selections do not jump.
  // The list remounts on the detail route and its document height collapses for a frame, so
  // hold the old height and restore the position before paint. Below xl the detail replaces
  // the list, so start that pane at its top instead.
  useLayoutEffect(() => {
    if (!showDetail) return;
    // jsdom (unit tests) has no matchMedia or usable scrollTo; the browser gate is the
    // two-column breakpoint, not a required feature of every environment.
    if (typeof window.matchMedia !== 'function') return;
    if (!window.matchMedia('(min-width: 1280px)').matches) {
      window.scrollTo(0, 0);
      return;
    }
    const y = takeListScroll();
    if (y <= 0) return;
    const root = document.documentElement;
    const previousMinHeight = root.style.minHeight;
    root.style.minHeight = `${y + window.innerHeight}px`;
    window.scrollTo(0, y);
    let frames = 0;
    const release = () => {
      frames += 1;
      const listHeight = masterRef.current?.scrollHeight ?? 0;
      if (listHeight >= y || frames > 30) {
        root.style.minHeight = previousMinHeight;
        return;
      }
      requestAnimationFrame(release);
    };
    requestAnimationFrame(release);
  }, [showDetail]);

  return (
    <div
      className={`mx-auto flex w-full max-w-[1720px] flex-col gap-4 p-4 xl:gap-6 xl:p-6 ${
        showDetail
          ? 'xl:grid xl:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] xl:items-start'
          : ''
      }`}
    >
      <div
        ref={masterRef}
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
