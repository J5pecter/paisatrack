/**
 * Chart palette and the one chart primitive small enough not to need Recharts.
 *
 * Kept separate from charts.tsx so that LazyCharts can re-export these without
 * statically importing the Recharts bundle — a static re-export would pull all
 * 430 kB back into the initial graph and quietly undo the lazy loading.
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

/** Tiny inline trend line for stat tiles and table rows. Plain SVG, no library. */
export function Sparkline({
  values,
  colour = CHART_COLOURS[0],
  width = 72,
  height = 22,
}: {
  values: number[];
  colour?: string;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <svg width={width} height={height} aria-hidden />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);

  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
    .join(' ');

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <polyline
        points={points}
        fill="none"
        stroke={colour}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
