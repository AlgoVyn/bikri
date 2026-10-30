/**
 * The master list and its detail are separate routes, so selecting a row remounts the list
 * and the document briefly collapses to the viewport. Browsers clamp the window scroll while
 * that happens, which made a desktop selection jump to the top. Remember the position before
 * the navigation and restore it in MasterDetail's layout effect.
 *
 * Only the >=1280 px two-column view keeps the position; below that the detail replaces the
 * list and MasterDetail starts it at the top instead.
 */
let savedScrollY = 0;

export function rememberListScroll(): void {
  savedScrollY =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(min-width: 1280px)').matches
      ? window.scrollY
      : 0;
}

/** Read and clear the remembered position. */
export function takeListScroll(): number {
  const value = savedScrollY;
  savedScrollY = 0;
  return value;
}
