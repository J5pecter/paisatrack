/**
 * Motion primitives.
 *
 * No animation library. Everything here is a spring integrator and a handful of
 * CSS custom properties, which is what the references this was modelled on
 * (smoothui, Amicro, inspora) are actually doing underneath — the depth comes
 * from `perspective` and `translateZ`, not from WebGL. Three.js would be ~150 kB
 * gzipped against a 300 kB budget, to render rectangles that CSS already
 * composites on the GPU for nothing.
 *
 * Two rules hold throughout:
 *
 * 1. **Transform and opacity only.** Those are the two properties the compositor
 *    can animate without touching layout or paint. Animating `width`, `top` or
 *    `box-shadow` forces a reflow on every frame and is why "smooth" UIs stop
 *    being smooth on a mid-range Android.
 * 2. **Reduced motion is honoured everywhere**, not as a courtesy but because
 *    vestibular disorders are real and this app is at 100 on accessibility.
 *    Every primitive degrades to the final state instantly.
 */

/** Does this user want motion? Re-read per call; the setting can change live. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface SpringConfig {
  /** Higher is snappier. */
  stiffness: number;
  /** Higher settles sooner with less overshoot. */
  damping: number;
  mass: number;
}

/**
 * Tuned presets.
 *
 * `snappy` is for direct manipulation — the thing should feel attached to the
 * cursor. `smooth` is for entrances. `gentle` is for anything large enough that
 * overshoot would read as a glitch rather than as life.
 */
export const SPRING = {
  snappy: { stiffness: 210, damping: 20, mass: 1 },
  smooth: { stiffness: 120, damping: 18, mass: 1 },
  gentle: { stiffness: 80, damping: 20, mass: 1 },
} satisfies Record<string, SpringConfig>;

/**
 * A semi-implicit Euler spring.
 *
 * Returns a `step` that advances toward the target and reports whether it has
 * settled. Deliberately not a duration-based easing: a spring interrupted
 * mid-flight carries its velocity into the new target, which is the difference
 * between a UI that feels physical and one that feels like it is replaying
 * canned clips.
 */
export function createSpring(initial: number, config: SpringConfig = SPRING.smooth) {
  let value = initial;
  let velocity = 0;
  let target = initial;

  return {
    get value() {
      return value;
    },
    setTarget(next: number) {
      target = next;
    },
    jumpTo(next: number) {
      value = next;
      target = next;
      velocity = 0;
    },
    /** @param dt seconds, clamped by the caller to survive a backgrounded tab. */
    step(dt: number): boolean {
      const force = -config.stiffness * (value - target);
      const damper = -config.damping * velocity;
      velocity += ((force + damper) / config.mass) * dt;
      value += velocity * dt;

      const settled = Math.abs(velocity) < 0.01 && Math.abs(value - target) < 0.01;
      if (settled) {
        value = target;
        velocity = 0;
      }
      return settled;
    },
  };
}

/**
 * Drive a spring with rAF, calling `onFrame` with each value.
 *
 * `dt` is clamped to 32ms. Without that, returning to a backgrounded tab
 * delivers one enormous frame and the integrator explodes — the element shoots
 * off screen. Learned the same lesson as the count-up animation in `Money`.
 */
export function animateSpring(
  from: number,
  to: number,
  onFrame: (v: number) => void,
  config: SpringConfig = SPRING.smooth,
): () => void {
  if (prefersReducedMotion()) {
    onFrame(to);
    return () => undefined;
  }

  const spring = createSpring(from, config);
  spring.setTarget(to);

  let raf = 0;
  let last = performance.now();

  const tick = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.032);
    last = now;
    const settled = spring.step(dt);
    onFrame(spring.value);
    if (!settled) raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** Clamp a number into a range. */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/**
 * Map a pointer position within an element to -1..1 on both axes.
 *
 * The basis for tilt and magnetic effects: everything downstream works in
 * normalised space, so the same numbers drive a 40px card and a full-width one.
 */
export function normalisedPointer(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  return {
    x: clamp(((clientX - rect.left) / rect.width) * 2 - 1, -1, 1),
    y: clamp(((clientY - rect.top) / rect.height) * 2 - 1, -1, 1),
  };
}

/**
 * Stagger delay for an item in a revealed list.
 *
 * Capped on purpose. Linear stagger over eighty rows means the last one appears
 * four seconds late, which stops reading as choreography and starts reading as
 * jank.
 */
export function staggerDelay(index: number, step = 40, max = 320): number {
  return Math.min(index * step, max);
}
