import { useEffect, useState } from 'react';

const DESKTOP_QUERY = '(min-width: 1024px)';

function readMedia(query: string): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia(query).matches;
}

/** Match a CSS media query once and keep it in sync with the viewport. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => readMedia(query));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);
  return matches;
}

/** The rail-only shell is desktop; tablets and phones keep the top bar (D-219/D-220). */
export function useIsDesktop(): boolean {
  return useMediaQuery(DESKTOP_QUERY);
}
