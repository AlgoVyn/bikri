import { useEffect, useState } from 'react';

const QUERY = '(min-width: 1024px)';

function readDesktop(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

/** The rail-only shell is desktop; tablets and phones keep the top bar (D-219/D-220). */
export function useIsDesktop(): boolean {
  const [desktop, setDesktop] = useState(readDesktop);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(QUERY);
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return desktop;
}
