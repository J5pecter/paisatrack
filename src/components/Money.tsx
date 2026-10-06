/**
 * Money display.
 *
 * Every rupee figure in the UI goes through here, so formatting, sign colouring
 * and the count-up animation stay consistent — and so nobody is tempted to do
 * `amount / 100` inline.
 */
import * as React from 'react';
import { formatCompactINR, formatINR, toRupees } from '@/lib/finance/money';
import { cn } from '@/lib/utils';
import type { Paise } from '@/types';

export interface MoneyProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: Paise;
  /** Abbreviate as K / L / Cr. */
  compact?: boolean;
  /** Show paise. Off by default — personal finance reads better in whole rupees. */
  paise?: boolean;
  showSign?: boolean;
  /** Green when positive, red when negative. */
  colour?: boolean;
  /** Green when negative instead — for expenses, where spending less is good. */
  invertColour?: boolean;
  animate?: boolean;
}

export function Money({
  value,
  compact = false,
  paise = false,
  showSign = false,
  colour = false,
  invertColour = false,
  animate = false,
  className,
  ...props
}: MoneyProps) {
  const display = useCountUp(value, animate);
  const text = formatINR(display, { compact, paise, showSign });

  const positive = value > 0;
  const negative = value < 0;
  const colourClass = colour
    ? invertColour
      ? negative
        ? 'text-[var(--color-success)]'
        : positive
          ? 'text-[var(--color-danger)]'
          : ''
      : positive
        ? 'text-[var(--color-success)]'
        : negative
          ? 'text-[var(--color-danger)]'
          : ''
    : '';

  return (
    <span className={cn('tnum', colourClass, className)} {...props}>
      {text}
    </span>
  );
}

/** Always abbreviated — for tight spaces like chart axes and stat tiles. */
export function CompactMoney({ value, className }: { value: Paise; className?: string }) {
  return (
    <span className={cn('tnum', className)} title={formatINR(value, { paise: true })}>
      {formatCompactINR(value)}
    </span>
  );
}

/**
 * Animate a number towards its new value.
 *
 * Deliberately short (400ms) and eased out — a dashboard that takes a second to
 * settle every time you tab back to it is annoying, not delightful. Respects
 * prefers-reduced-motion.
 */
const COUNT_UP_MS = 400;

function useCountUp(target: Paise, enabled: boolean): Paise {
  const [display, setDisplay] = React.useState(target);
  /** What is on screen right now — the animation always resumes from here. */
  const displayRef = React.useRef(target);
  const rafRef = React.useRef<number | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    const settle = () => {
      displayRef.current = target;
      setDisplay(target);
    };

    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    // Browsers pause requestAnimationFrame in a hidden tab. Animating there
    // would leave every figure frozen at its starting value, so a backgrounded
    // dashboard would read "₹0 net worth" until you looked at it. For a money
    // app that is not a cosmetic bug, it is a lie — so the animation is only
    // ever an enhancement, never the path by which the real number arrives.
    const hidden = typeof document !== 'undefined' && document.hidden;

    if (!enabled || reduced || hidden) {
      settle();
      return;
    }

    const from = displayRef.current;
    if (from === target) return;

    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - (1 - t) ** 3;
      const next = t < 1 ? Math.round(from + (target - from) * eased) : target;
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    // Belt and braces: if the frames never arrive (tab hidden mid-flight,
    // throttled, whatever), land on the true value anyway. Timers still fire in
    // background tabs even when rAF does not.
    timerRef.current = setTimeout(settle, COUNT_UP_MS + 250);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
      // Deliberately does NOT snap displayRef to `target`. StrictMode runs
      // effect -> cleanup -> effect on mount; snapping here would make the
      // second run see from === target, bail out, and leave the figure stuck
      // at its initial value forever.
    };
  }, [target, enabled]);

  return display;
}

/** Rupee value as a plain number, for chart data. */
export function rupees(value: Paise): number {
  return toRupees(value);
}
