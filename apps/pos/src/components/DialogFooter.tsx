import type { ReactNode } from 'react';

/**
 * The sticky action row of a dialog form. On phones it anchors to the bottom of the
 * full-screen sheet and stays visible while the fields scroll; on larger screens it is
 * the last row of a compact dialog. Its background and top border are full-bleed.
 */
export function DialogFooter({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`-mx-4 -mb-4 mt-auto flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] max-md:sticky max-md:bottom-0 max-md:z-10 max-md:mb-0 ${className}`}
    >
      {children}
    </div>
  );
}
