import { useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import type { MouseEvent } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { rememberPeekTrigger } from './focus.ts';
import {
  type PeekOrigin,
  type PeekOriginSpec,
  type PeekTarget,
  parseOrigin,
  parsePeekTarget,
  peekValue,
  stripPeekFromHref,
} from './peek.ts';

function isPlainLeftClick(event: MouseEvent<HTMLElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/**
 * Open a reference peek without leaving the current page. The original click is turned
 * into a same-route history entry carrying `peek` and the origin descriptor; modifier
 * clicks fall through to the real link (new tab).
 */
export function useOpenPeek() {
  const navigate = useNavigate();
  const location = useLocation();
  const opening = useRef(false);
  const lastSearch = useRef(location.search);
  useEffect(() => {
    // The URL updates when the peek entry is pushed; reset the synchronous guard.
    if (lastSearch.current === location.search) return;
    lastSearch.current = location.search;
    opening.current = false;
  }, [location.search]);
  return useCallback(
    (
      event: MouseEvent<HTMLElement>,
      target: PeekTarget,
      origin: PeekOriginSpec,
    ) => {
      if (!isPlainLeftClick(event)) return;
      // A double click fires twice before the first navigation renders the modal.
      if (
        parsePeekTarget(new URLSearchParams(location.search).get('peek')) !==
        null
      )
        return;
      rememberPeekTrigger();
      event.preventDefault();
      const state: PeekOrigin = {
        href: stripPeekFromHref(location.href),
        labelKey: origin.key,
        labelParams: origin.params,
        mode: 'history',
      };
      void navigate({
        to: '.',
        search: (previous) => ({
          ...previous,
          peek: peekValue(target),
        }),
        state: (previous) => ({ ...previous, bikriPeek: state }),
      });
    },
    [navigate, location.href, location.search],
  );
}

/**
 * Close the peek. An in-app peek has its origin as the previous history entry, so pop
 * it; a deep-linked peek has no safe previous entry and replaces the URL instead.
 */
export function useClosePeek() {
  const navigate = useNavigate();
  const router = useRouter();
  const location = useLocation();
  return useCallback(() => {
    const state = location.state as unknown as
      | Record<string, unknown>
      | undefined;
    const origin = parseOrigin(state?.bikriPeek);
    if (origin?.mode === 'history' && window.history.length > 1) {
      router.history.back();
      return;
    }
    void navigate({
      to: '.',
      search: (previous) => {
        const next = { ...(previous as unknown as Record<string, unknown>) };
        delete next.peek;
        return next as typeof previous;
      },
      state: (previous) => {
        const next = { ...(previous as unknown as Record<string, unknown>) };
        delete next.bikriPeek;
        return next;
      },
      replace: true,
    });
  }, [navigate, router, location.state]);
}
