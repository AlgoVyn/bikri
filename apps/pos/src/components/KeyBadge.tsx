import { useEffect, useState } from 'react';

function readCoarsePointer(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }
  return window.matchMedia('(pointer: coarse)').matches;
}

/** Small shortcut hint. Hidden on a touch-only device until a keyboard is used. */
export function KeyBadge({ keys }: { keys: string }) {
  const [coarse, setCoarse] = useState(readCoarsePointer);
  const [keyboardSeen, setKeyboardSeen] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const query = window.matchMedia('(pointer: coarse)');
    const update = () => {
      setCoarse(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);

  useEffect(() => {
    if (!coarse || keyboardSeen) {
      return;
    }
    const onKey = () => {
      setKeyboardSeen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [coarse, keyboardSeen]);

  if (coarse && !keyboardSeen) {
    return null;
  }

  return (
    <kbd className="inline-flex items-center rounded-control bg-surface-2 px-1 font-mono text-small text-text-muted">
      {keys}
    </kbd>
  );
}
