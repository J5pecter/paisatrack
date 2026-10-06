/**
 * Interactive surfaces.
 *
 * The depth here is CSS 3D — `perspective` plus `rotateX/rotateY/translateZ`
 * on the GPU — driven by springs from `lib/motion.ts`. That is the same
 * technique the references behind this work use; none of them is running a 3D
 * engine to draw a card.
 *
 * Everything degrades to a static element under `prefers-reduced-motion`, and
 * every pointer effect is skipped entirely on touch, where there is no hover
 * state to reward and the handlers would only cost battery.
 */
import * as React from 'react';
import {
  SPRING,
  animateSpring,
  clamp,
  normalisedPointer,
  prefersReducedMotion,
  staggerDelay,
} from '@/lib/motion';
import { cn } from '@/lib/utils';

/** Pointer that can hover — i.e. a mouse, not a finger. */
function useHasHover(): boolean {
  const [hover, setHover] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia?.('(hover: hover) and (pointer: fine)');
    if (!mq) return;
    setHover(mq.matches);
    const on = () => setHover(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return hover;
}

/**
 * A card that tilts toward the cursor and lifts slightly.
 *
 * `maxTilt` stays small by design. Past about 8° the text starts to shear
 * noticeably and a finance figure becomes harder to read, which is a bad trade
 * for a number someone is trying to check.
 */
export function TiltCard({
  children,
  className,
  maxTilt = 6,
  lift = 10,
  glare = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  maxTilt?: number;
  lift?: number;
  glare?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const hasHover = useHasHover();
  const active = hasHover && !prefersReducedMotion();

  const onMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const el = ref.current;
      if (!el || !active) return;
      const { x, y } = normalisedPointer(el.getBoundingClientRect(), e.clientX, e.clientY);
      // Writing custom properties rather than `style.transform` lets the CSS
      // own the composition, so hover/focus states can add to it without the
      // two fighting over the same declaration.
      el.style.setProperty('--tilt-x', `${(-y * maxTilt).toFixed(2)}deg`);
      el.style.setProperty('--tilt-y', `${(x * maxTilt).toFixed(2)}deg`);
      el.style.setProperty('--tilt-z', `${lift}px`);
      el.style.setProperty('--glare-x', `${((x + 1) / 2) * 100}%`);
      el.style.setProperty('--glare-y', `${((y + 1) / 2) * 100}%`);
      el.style.setProperty('--glare-o', '1');
    },
    [active, maxTilt, lift],
  );

  const reset = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--tilt-x', '0deg');
    el.style.setProperty('--tilt-y', '0deg');
    el.style.setProperty('--tilt-z', '0px');
    el.style.setProperty('--glare-o', '0');
  }, []);

  return (
    <div
      ref={ref}
      onPointerMove={active ? onMove : undefined}
      onPointerLeave={active ? reset : undefined}
      className={cn('tilt-card', glare && 'tilt-card--glare', className)}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * A button whose label drifts toward the cursor as it approaches.
 *
 * `strength` is in pixels of maximum travel. Kept low — a control that moves
 * far enough to escape the pointer is a joke the second time.
 */
export function Magnetic({
  children,
  className,
  strength = 6,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { strength?: number }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const hasHover = useHasHover();
  const active = hasHover && !prefersReducedMotion();

  const onMove = React.useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      const el = ref.current;
      if (!el) return;
      const { x, y } = normalisedPointer(el.getBoundingClientRect(), e.clientX, e.clientY);
      el.style.setProperty('--mag-x', `${(x * strength).toFixed(2)}px`);
      el.style.setProperty('--mag-y', `${(y * strength).toFixed(2)}px`);
    },
    [strength],
  );

  const reset = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--mag-x', '0px');
    el.style.setProperty('--mag-y', '0px');
  }, []);

  return (
    <span
      ref={ref}
      onPointerMove={active ? onMove : undefined}
      onPointerLeave={active ? reset : undefined}
      className={cn('magnetic', className)}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * Reveals its children once they scroll near the viewport.
 *
 * One observer per element is wasteful at scale, but these are section-level
 * wrappers — a page has a handful, not hundreds. Rows use `delay` from
 * `staggerDelay` instead of each observing separately.
 *
 * Disconnects on first intersection: this is a latch. Re-animating on every
 * scroll past is the single most irritating thing a page can do.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  as: Tag = 'div',
  ...props
}: React.HTMLAttributes<HTMLElement> & { delay?: number; as?: React.ElementType }) {
  const ref = React.useRef<HTMLElement>(null);
  const [shown, setShown] = React.useState(() => prefersReducedMotion());

  React.useEffect(() => {
    if (shown) return;
    const el = ref.current;
    if (!el) return;

    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px' },
    );
    io.observe(el);

    /**
     * Fail open.
     *
     * The hidden state is `opacity: 0`, so if the observer never reports —
     * a zero-height viewport, a backgrounded tab that defers callbacks, an
     * ancestor that is display:none when this mounts — the content is not
     * merely unanimated, it is *gone*. An entrance effect must never be the
     * only path by which content becomes visible. Same rule that the count-up
     * animation in `Money` learned the hard way.
     *
     * 1200ms is comfortably longer than any genuine scroll-into-view, so in
     * normal use this timer is cleared without ever firing.
     */
    const backstop = setTimeout(() => {
      setShown(true);
      io.disconnect();
    }, 1200);

    return () => {
      clearTimeout(backstop);
      io.disconnect();
    };
  }, [shown]);

  return (
    <Tag
      ref={ref}
      data-revealed={shown ? '' : undefined}
      style={{ '--reveal-delay': `${delay}ms` } as React.CSSProperties}
      className={cn('reveal', className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

/** `Reveal` for a list, with the stagger already worked out. */
export function RevealList({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={className} {...props}>
      {React.Children.map(children, (child, i) => (
        <Reveal delay={staggerDelay(i)}>{child}</Reveal>
      ))}
    </div>
  );
}

/**
 * A bar that springs to its value rather than easing linearly.
 *
 * Used for utilisation and budget meters, where the overshoot genuinely helps:
 * a bar that bounces slightly past 90% draws the eye to the number that
 * matters in a way a linear fill does not.
 */
export function SpringBar({
  value,
  max = 100,
  className,
  barClassName,
  label,
}: {
  value: number;
  max?: number;
  className?: string;
  barClassName?: string;
  label?: string;
}) {
  const target = clamp(max > 0 ? (value / max) * 100 : 0, 0, 100);
  const [width, setWidth] = React.useState(() => (prefersReducedMotion() ? target : 0));
  const previous = React.useRef(width);

  React.useEffect(() => {
    const stop = animateSpring(
      previous.current,
      target,
      (v) => {
        previous.current = v;
        setWidth(v);
      },
      SPRING.gentle,
    );
    return stop;
  }, [target]);

  return (
    <div
      className={cn('h-2 w-full overflow-hidden rounded-full bg-[var(--color-muted)]', className)}
      role="meter"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className={cn('h-full rounded-full bg-[var(--color-primary)]', barClassName)}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/**
 * Press feedback.
 *
 * Scales down on pointer-down and springs back on release. The whole trick is
 * that it responds to *press*, not to click — the gap between the two is where
 * an interface feels unresponsive even when it is fast.
 */
export function Pressable({
  children,
  className,
  scale = 0.97,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { scale?: number }) {
  return (
    <div
      className={cn('pressable', className)}
      style={{ '--press-scale': scale } as React.CSSProperties}
      {...props}
    >
      {children}
    </div>
  );
}
