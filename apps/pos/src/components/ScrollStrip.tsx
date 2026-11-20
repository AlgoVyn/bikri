import {
  type CSSProperties,
  type HTMLAttributes,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A row of chips or tabs. It wraps on desktop and becomes a horizontal strip on
 * phones, so seven date chips or seven tabs never eat three rows of the screen.
 *
 * The edge fade is applied only while there is content hidden past that edge;
 * a symmetric static mask faded the first chip even at `scrollLeft = 0` (D-267).
 */
export const scrollStrip =
  'scroll-strip flex flex-wrap gap-1 max-lg:-mx-3 max-lg:flex-nowrap max-lg:overflow-x-auto max-lg:px-3 max-lg:pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0';

const EDGE = 24;

/** The edge fade for a strip at `scrollLeft` (negative in RTL) and `overflow` px. */
export function scrollMaskImage(
  scrollLeft: number,
  overflow: number,
  rtl: boolean,
): string | undefined {
  if (overflow <= 1) return undefined;
  const offset = Math.abs(scrollLeft);
  const atStart = offset < 1;
  const atEnd = offset >= overflow - 1;
  if (atStart && atEnd) return undefined;
  const to = rtl ? 'to left' : 'to right';
  if (atStart) {
    return `linear-gradient(${to}, black calc(100% - ${EDGE}px), transparent)`;
  }
  if (atEnd) {
    return `linear-gradient(${to}, transparent, black ${EDGE}px)`;
  }
  return `linear-gradient(${to}, transparent, black ${EDGE}px, black calc(100% - ${EDGE}px), transparent)`;
}

export function useScrollStripMask<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  style: CSSProperties;
} {
  const { i18n } = useTranslation();
  const ref = useRef<T>(null);
  const [maskImage, setMaskImage] = useState<string | undefined>(undefined);

  // Re-run when the language flips the document direction, because the fade
  // gradient is physical (`to right`/`to left`) even though the edges are logical.
  // biome-ignore lint/correctness/useExhaustiveDependencies: i18n.language is the direction trigger
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const overflow = element.scrollWidth - element.clientWidth;
      setMaskImage(
        scrollMaskImage(
          element.scrollLeft,
          overflow,
          getComputedStyle(element).direction === 'rtl',
        ),
      );
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [i18n.language]);

  return {
    ref,
    style: {
      WebkitMaskImage: maskImage,
      maskImage,
    },
  };
}

/** The shared horizontal chip/tab strip with edge-aware scroll fades. */
export function ScrollStrip({
  className = '',
  style,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const { ref, style: maskStyle } = useScrollStripMask<HTMLDivElement>();
  return (
    <div
      ref={ref}
      {...props}
      className={`${scrollStrip} ${className}`}
      style={{ ...style, ...maskStyle }}
    >
      {children}
    </div>
  );
}
