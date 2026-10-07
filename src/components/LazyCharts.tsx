/**
 * Lazy chart wrappers.
 *
 * Recharts is the single largest dependency in the app and every chart sits
 * below the fold, so it is split out and loaded after first paint. Each wrapper
 * reserves the chart's height while loading, which keeps the layout from
 * jumping once it arrives.
 *
 * Mounting is also deferred until the chart is near the viewport. Rendering the
 * wrapper used to be enough to trigger the import, so a dashboard chart the
 * user had not scrolled to still cost 116 kB during load. Printing and PDF
 * export are the two cases that need real charts without any scrolling, so
 * they force every chart to mount through `mountAllCharts()`.
 */
import * as React from 'react';
import { Skeleton } from '@/components/ui';
import type {
  BalanceOverTimeChart as BalanceOverTimeChartType,
  CategoryDonut as CategoryDonutType,
  SimpleBarChart as SimpleBarChartType,
  TrendChart as TrendChartType,
  UnitsAndAmountChart as UnitsAndAmountChartType,
  UtilizationTrendChart as UtilizationTrendChartType,
} from '@/components/charts';

const charts = () => import('@/components/charts');

/* ------------------------------------------------------------------ *
 * The force-mount latch.
 *
 * One-way: once set it never clears, because a chart that has rendered has
 * already paid for itself and un-mounting it would only cause flicker.
 * ------------------------------------------------------------------ */

let forced = false;
const listeners = new Set<() => void>();

/**
 * Mount every chart immediately, regardless of scroll position.
 *
 * Returns once the chart module is loaded. Callers that are about to capture
 * the DOM (PDF export) should await this and then let React commit, otherwise
 * they photograph the skeletons.
 */
export async function mountAllCharts(): Promise<void> {
  if (!forced) {
    forced = true;
    for (const notify of listeners) notify();
  }
  await charts();
  // Two frames: one for React to render, one for Recharts to lay out its SVG.
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

if (typeof window !== 'undefined') {
  // Ctrl-P must not produce a page of grey rectangles.
  window.addEventListener('beforeprint', () => void mountAllCharts());
}

function useForced(): boolean {
  return React.useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => forced,
  );
}

function placeholder(height: number) {
  return (
    <div className="flex items-end gap-2" style={{ height }} aria-busy="true" aria-label="Loading chart">
      {[0.4, 0.7, 0.5, 0.9, 0.6, 0.8, 0.45, 0.75].map((h, i) => (
        <Skeleton key={i} className="flex-1" style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}

/**
 * Renders a placeholder until the chart is within 400px of the viewport, then
 * hands over to Suspense. The observer is disconnected on first intersection —
 * this is a latch, not a visibility toggle.
 */
function Deferred({ height, children }: { height: number; children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const isForced = useForced();
  const [near, setNear] = React.useState(false);

  React.useEffect(() => {
    if (near || isForced) return;
    const el = ref.current;
    if (!el) return;

    // Older browsers and jsdom have no observer; render rather than stall.
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '400px' },
    );
    io.observe(el);

    /**
     * Fail open, same as `Reveal`.
     *
     * If the observer never reports — a zero-height viewport, a tab panel that
     * was display:none when this mounted, a backgrounded tab deferring
     * callbacks — the chart does not stay unanimated, it stays a skeleton
     * forever. Less brutal than vanishing content, but still a permanent
     * placeholder where data should be.
     *
     * Longer than Reveal's backstop because this one pulls a 413 kB chunk:
     * firing it eagerly would defeat the deferral it exists to protect. Three
     * seconds is well past any genuine scroll-into-view.
     */
    const backstop = setTimeout(() => {
      setNear(true);
      io.disconnect();
    }, 3000);

    return () => {
      clearTimeout(backstop);
      io.disconnect();
    };
  }, [near, isForced]);

  return (
    <div ref={ref}>
      {near || isForced ? (
        <React.Suspense fallback={placeholder(height)}>{children}</React.Suspense>
      ) : (
        placeholder(height)
      )}
    </div>
  );
}

const CategoryDonutLazy = React.lazy(() => charts().then((m) => ({ default: m.CategoryDonut })));
const TrendChartLazy = React.lazy(() => charts().then((m) => ({ default: m.TrendChart })));
const SimpleBarChartLazy = React.lazy(() => charts().then((m) => ({ default: m.SimpleBarChart })));
const UnitsAndAmountChartLazy = React.lazy(() =>
  charts().then((m) => ({ default: m.UnitsAndAmountChart })),
);
const BalanceOverTimeChartLazy = React.lazy(() =>
  charts().then((m) => ({ default: m.BalanceOverTimeChart })),
);
const UtilizationTrendChartLazy = React.lazy(() =>
  charts().then((m) => ({ default: m.UtilizationTrendChart })),
);

export const CategoryDonut: typeof CategoryDonutType = (props) => (
  <Deferred height={props.height ?? 260}>
    <CategoryDonutLazy {...props} />
  </Deferred>
);

export const TrendChart: typeof TrendChartType = (props) => (
  <Deferred height={props.height ?? 280}>
    <TrendChartLazy {...props} />
  </Deferred>
);

export const SimpleBarChart: typeof SimpleBarChartType = (props) => (
  <Deferred height={props.height ?? 220}>
    <SimpleBarChartLazy {...props} />
  </Deferred>
);

export const UnitsAndAmountChart: typeof UnitsAndAmountChartType = (props) => (
  <Deferred height={props.height ?? 240}>
    <UnitsAndAmountChartLazy {...props} />
  </Deferred>
);

export const BalanceOverTimeChart: typeof BalanceOverTimeChartType = (props) => (
  <Deferred height={props.height ?? 260}>
    <BalanceOverTimeChartLazy {...props} />
  </Deferred>
);

export const UtilizationTrendChart: typeof UtilizationTrendChartType = (props) => (
  <Deferred height={props.height ?? 200}>
    <UtilizationTrendChartLazy {...props} />
  </Deferred>
);

/**
 * Re-exported from the palette module, NOT from charts.tsx. Re-exporting from
 * charts.tsx would be a static import of Recharts and would defeat everything
 * above it in this file.
 */
export { CHART_COLOURS, colourFor } from '@/components/chartPalette';
