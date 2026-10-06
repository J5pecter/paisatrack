/**
 * Small performance primitives.
 *
 * Deliberately hand-written rather than pulled in as dependencies: each is a
 * dozen lines, and the behaviour that matters here (the trailing edge, the
 * cleanup, the overscan) is worth being able to read.
 */
import * as React from 'react';

/**
 * Debounce a value.
 *
 * Used for text filters. Filtering a few hundred expenses is fast, but doing it
 * on every keystroke also re-renders the table on every keystroke, and typing
 * "groceries" should cost one render, not nine.
 *
 * Deliberately not used for amount or date filters — those change once, so a
 * delay would only make them feel broken.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}

/** Debounce a callback. Returns a stable function. */
export function useDebouncedCallback<A extends unknown[]>(
  fn: (...args: A) => void,
  delayMs = 200,
): (...args: A) => void {
  const fnRef = React.useRef(fn);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return React.useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(...args), delayMs);
    },
    [delayMs],
  );
}

/**
 * Show a growing window of a long list.
 *
 * A deliberately simple alternative to a virtualisation library. Full windowing
 * (absolute positioning, measured row heights) fights against a semantic
 * `<table>`, and a table is the right element for a list of amounts — screen
 * readers announce the column, and the markup stays printable.
 *
 * So instead of rendering a floating window, this renders the first N rows and
 * extends N as the sentinel scrolls into view. The DOM stays small on arrival,
 * which is where the cost actually is, and scrolling never jumps.
 */
export function useProgressiveList<T>(
  items: T[],
  pageSize = 100,
): {
  visible: T[];
  hasMore: boolean;
  remaining: number;
  sentinelRef: (node: HTMLElement | null) => void;
  showAll: () => void;
} {
  const [limit, setLimit] = React.useState(pageSize);
  const observer = React.useRef<IntersectionObserver | null>(null);

  // A new filter result should start from the top again.
  React.useEffect(() => {
    setLimit(pageSize);
  }, [items.length, pageSize]);

  const sentinelRef = React.useCallback(
    (node: HTMLElement | null) => {
      observer.current?.disconnect();
      if (!node) return;

      observer.current = new IntersectionObserver(
        (entries) => {
          if (entries[0]?.isIntersecting) {
            setLimit((n) => n + pageSize);
          }
        },
        // Start loading before the sentinel is actually on screen.
        { rootMargin: '400px' },
      );
      observer.current.observe(node);
    },
    [pageSize],
  );

  React.useEffect(() => () => observer.current?.disconnect(), []);

  const visible = React.useMemo(() => items.slice(0, limit), [items, limit]);

  return {
    visible,
    hasMore: items.length > limit,
    remaining: Math.max(0, items.length - limit),
    sentinelRef,
    showAll: () => setLimit(items.length),
  };
}

/**
 * How far down the page the reader has scrolled, 0–100.
 *
 * Passive listener and a rAF guard, because a scroll handler that triggers a
 * React render on every event is a reliable way to make a page feel heavy.
 */
export function useScrollProgress(): number {
  const [progress, setProgress] = React.useState(0);

  React.useEffect(() => {
    let frame = 0;

    const read = () => {
      frame = 0;
      const el = document.documentElement;
      const scrollable = el.scrollHeight - el.clientHeight;
      setProgress(scrollable > 0 ? Math.min(100, (el.scrollTop / scrollable) * 100) : 0);
    };

    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };

    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  return progress;
}

/** True once the page has been scrolled past `threshold` pixels. */
export function useScrolledPast(threshold = 400): boolean {
  const [past, setPast] = React.useState(false);

  React.useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      setPast(document.documentElement.scrollTop > threshold);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
    };
  }, [threshold]);

  return past;
}
