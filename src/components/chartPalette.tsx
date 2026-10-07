/**
 * Chart palette.
 *
 * Kept separate from charts.tsx so that LazyCharts can re-export these without
 * statically importing the Recharts bundle — a static re-export would pull all
 * 413 kB back into the initial graph and quietly undo the lazy loading.
 *
 * This file once also held a `Sparkline`, which is why it is described as the
 * palette *and* a primitive in older commits. Nothing ever rendered it, so it
 * was removed; the separation above is still the reason this file exists.
 */
import { colourIndex } from '@/lib/utils';

/**
 * Categorical palette. Ordered so adjacent slices stay distinguishable, and
 * chosen to stay legible on both the dark and light backgrounds.
 */
export const CHART_COLOURS = [
  '#22c55e', // green
  '#38bdf8', // sky
  '#a78bfa', // violet
  '#fbbf24', // amber
  '#fb7185', // rose
  '#2dd4bf', // teal
  '#f472b6', // pink
  '#818cf8', // indigo
  '#facc15', // yellow
  '#4ade80', // light green
  '#60a5fa', // blue
  '#c084fc', // purple
];

/** Stable colour for a label, so a category keeps its colour across charts. */
export function colourFor(label: string): string {
  return CHART_COLOURS[colourIndex(label, CHART_COLOURS.length)];
}
