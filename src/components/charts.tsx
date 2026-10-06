/**
 * Charts.
 *
 * All financial charts in one place so they share a palette, an axis
 * convention and a tooltip. Recharts wants plain numbers, so every series
 * converts paise to rupees at the boundary and formats back to rupees for
 * display — the raw paise never reach the chart.
 */
import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Sector,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatCompactINR, formatINR, toRupees } from '@/lib/finance/money';
import { formatMonthKey } from '@/lib/finance/dates';
import { humanise } from '@/lib/utils';
import { ChartStage } from '@/components/motion';
import { prefersReducedMotion } from '@/lib/motion';
import type { PieSectorDataItem } from 'recharts/types/polar/Pie';
import { CHART_COLOURS, colourFor } from './chartPalette';
import type { CategorySpend, MonthlyTrendPoint } from '@/lib/finance/dashboard';
import type { Paise } from '@/types';

export { CHART_COLOURS, colourFor, Sparkline } from './chartPalette';

const AXIS = {
  stroke: 'var(--color-muted-foreground)',
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

/** Shared tooltip. Values arrive as rupees and are shown as full rupee amounts. */
function MoneyTooltip({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string; payload?: unknown }>;
  label?: string | number;
  labelFormatter?: (label: string) => string;
}) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-3 py-2 text-xs shadow-lg">
      {label !== undefined && (
        <p className="mb-1 font-medium">
          {labelFormatter ? labelFormatter(String(label)) : String(label)}
        </p>
      )}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-2 whitespace-nowrap">
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
            aria-hidden
          />
          <span className="text-[var(--color-muted-foreground)]">{entry.name}</span>
          <span className="tnum ml-auto font-medium">
            {formatINR(Math.round(Number(entry.value ?? 0) * 100))}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Category donut
// ---------------------------------------------------------------------------

export function CategoryDonut({ data, height = 260 }: { data: CategorySpend[]; height?: number }) {
  const rows = React.useMemo(
    () =>
      data.slice(0, 9).map((d) => ({
        name: humanise(d.category),
        value: toRupees(d.amount),
        paise: d.amount,
        percent: d.percent,
      })),
    [data],
  );

  const total = React.useMemo(() => data.reduce((s, d) => s + d.amount, 0), [data]);

  /**
   * Which slice the pointer is on.
   *
   * Recharts 3 dropped `activeIndex` from `Pie` — the active sector is now
   * decided internally from hover and handed to `activeShape`. The mouse
   * callbacks still report the index, so this mirrors that state for the
   * centre readout and the legend, rather than trying to drive Recharts from
   * the outside.
   */
  const [active, setActive] = React.useState<number | null>(null);
  const shown = active !== null ? rows[active] : null;

  return (
    <div className="relative">
      <ChartStage backdrop={false}>
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={rows}
              dataKey="value"
              nameKey="name"
              innerRadius="58%"
              outerRadius="86%"
              paddingAngle={2}
              strokeWidth={0}
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(null)}
              // The hovered sector grows outward and gains a shadow, so it
              // reads as lifted off the ring rather than merely larger.
              activeShape={(props: PieSectorDataItem) => (
                <Sector
                  {...props}
                  // Proportional, not a fixed +10px. The ring ends at 86% of
                  // the available radius, so there is ~14% of headroom; 8%
                  // always fits inside it, where a constant would clip against
                  // the SVG edge once the container got small enough.
                  outerRadius={(props.outerRadius ?? 0) * 1.08}
                  className="sector-lift"
                />
              )}
              // Everything else recedes. Dimming the rest is what makes the
              // lift legible — a shadow alone is easy to miss at this size.
              inactiveShape={(props: PieSectorDataItem) => (
                <Sector {...props} opacity={0.45} />
              )}
            >
              {rows.map((row) => (
                <Cell key={row.name} fill={colourFor(row.name)} />
              ))}
            </Pie>
            <RechartsTooltip content={<MoneyTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </ChartStage>

      {/*
        The hole. Shows the total until a slice is hovered, then that slice —
        which is the whole point of hovering it. `aria-live` is deliberately
        off: this mirrors a pointer-only affordance, and announcing every
        slice as the mouse crosses the ring would be unusable.
      */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        {shown ? (
          <>
            <span className="max-w-[7rem] truncate text-xs text-[var(--color-muted-foreground)]">
              {shown.name}
            </span>
            <span className="tnum text-lg font-semibold">{formatCompactINR(shown.paise)}</span>
            <span className="tnum text-xs text-[var(--color-muted-foreground)]">
              {shown.percent.toFixed(0)}% of spend
            </span>
          </>
        ) : (
          <>
            <span className="text-xs text-[var(--color-muted-foreground)]">Total</span>
            <span className="tnum text-lg font-semibold">{formatCompactINR(total)}</span>
          </>
        )}
      </div>

      <ul className="mt-4 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {rows.map((row, i) => (
          <li
            key={row.name}
            className="legend-row flex items-center gap-2 py-0.5 text-xs"
            data-active={active === i ? '' : undefined}
            // Opacity is set inline rather than from the stylesheet. The
            // attribute rule for it refused to apply while its immediate
            // neighbour `[data-active]` applied fine, and the dim level is
            // state anyway — driving it from the same place as the state
            // removes a second source of truth and a cascade to argue with.
            style={{ opacity: active !== null && active !== i ? 0.4 : 1 }}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive(null)}
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: colourFor(row.name) }}
              aria-hidden
            />
            <span className="truncate text-[var(--color-muted-foreground)]">{row.name}</span>
            <span className="tnum ml-auto font-medium">{formatCompactINR(row.paise)}</span>
            <span className="tnum w-9 text-right text-[var(--color-muted-foreground)]">
              {row.percent.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Income vs spending trend
// ---------------------------------------------------------------------------

export function TrendChart({ data, height = 280 }: { data: MonthlyTrendPoint[]; height?: number }) {
  const rows = React.useMemo(
    () =>
      data.map((d) => ({
        month: d.month,
        label: formatMonthKey(d.month).replace(' ', '\n'),
        Income: toRupees(d.income),
        Spending: toRupees(d.expenses + d.bills),
        EMI: toRupees(d.emi),
        Savings: toRupees(d.savings),
      })),
    [data],
  );

  // Read once per mount, like the count-up in `Money`. A live change to the
  // setting is rare enough not to be worth a listener here, and getting it
  // wrong in the other direction — animating for someone who asked not to —
  // is the failure that actually matters.
  const still = prefersReducedMotion();

  return (
    <ChartStage>
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="month" tickFormatter={(m) => formatMonthKey(m).slice(0, 3)} {...AXIS} />
          <YAxis tickFormatter={(v) => formatCompactINR(Math.round(v * 100), { noSymbol: true })} {...AXIS} />
          <RechartsTooltip
            content={<MoneyTooltip />}
            labelFormatter={(label) => formatMonthKey(String(label))}
            cursor={{ fill: 'color-mix(in oklab, var(--color-foreground) 6%, transparent)' }}
          />
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={7} />

          {/*
            Staged entrance: the bars rise, then the income line draws across
            them. Sequencing it this way means the line is read *against* the
            spending rather than alongside it, which is the comparison the
            chart exists to make. The offsets are small — past about half a
            second a chart stops feeling alive and starts feeling slow.
          */}
          <Bar
            dataKey="Spending"
            fill={CHART_COLOURS[4]}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
            isAnimationActive={!still}
            animationBegin={0}
            animationDuration={520}
            animationEasing="ease-out"
          />
          <Bar
            dataKey="EMI"
            fill={CHART_COLOURS[3]}
            radius={[3, 3, 0, 0]}
            maxBarSize={28}
            stackId="out"
            isAnimationActive={!still}
            animationBegin={110}
            animationDuration={520}
            animationEasing="ease-out"
          />
          <Line
            type="monotone"
            dataKey="Income"
            stroke={CHART_COLOURS[0]}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 0 }}
            isAnimationActive={!still}
            animationBegin={320}
            animationDuration={680}
            animationEasing="ease-out"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartStage>
  );
}

// ---------------------------------------------------------------------------
// Generic series charts
// ---------------------------------------------------------------------------

export interface SimpleSeriesPoint {
  label: string;
  value: Paise;
  secondary?: number;
}

/** A single-series bar chart, used for utilization history and spend by month. */
export function SimpleBarChart({
  data,
  height = 220,
  colour = CHART_COLOURS[0],
  name = 'Amount',
}: {
  data: SimpleSeriesPoint[];
  height?: number;
  colour?: string;
  name?: string;
}) {
  const rows = React.useMemo(
    () => data.map((d) => ({ label: d.label, [name]: toRupees(d.value) })),
    [data, name],
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis tickFormatter={(v) => formatCompactINR(Math.round(v * 100), { noSymbol: true })} {...AXIS} />
        <RechartsTooltip content={<MoneyTooltip />} cursor={{ fill: 'var(--color-accent)', opacity: 0.4 }} />
        <Bar dataKey={name} fill={colour} radius={[3, 3, 0, 0]} maxBarSize={36} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * Electricity: units as bars against the rupee amount as a line, so a jump in
 * consumption is visibly separable from a tariff rise.
 */
export function UnitsAndAmountChart({
  data,
  height = 240,
}: {
  data: Array<{ month: string; units: number; amount: Paise }>;
  height?: number;
}) {
  const rows = React.useMemo(
    () =>
      data.map((d) => ({
        month: d.month,
        Units: d.units,
        Amount: toRupees(d.amount),
      })),
    [data],
  );

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="month" tickFormatter={(m) => formatMonthKey(m).slice(0, 3)} {...AXIS} />
        <YAxis yAxisId="units" {...AXIS} />
        <YAxis
          yAxisId="amount"
          orientation="right"
          tickFormatter={(v) => formatCompactINR(Math.round(v * 100), { noSymbol: true })}
          {...AXIS}
        />
        <RechartsTooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const units = payload.find((p) => p.name === 'Units')?.value as number | undefined;
            const amount = payload.find((p) => p.name === 'Amount')?.value as number | undefined;
            const rate = units && amount ? amount / units : 0;
            return (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-3 py-2 text-xs shadow-lg">
                <p className="mb-1 font-medium">{formatMonthKey(String(label))}</p>
                <p className="tnum">{units ?? 0} units</p>
                <p className="tnum">{formatINR(Math.round((amount ?? 0) * 100))}</p>
                <p className="tnum text-[var(--color-muted-foreground)]">
                  {formatINR(Math.round(rate * 100))} per unit
                </p>
              </div>
            );
          }}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={7} />
        <Bar yAxisId="units" dataKey="Units" fill={CHART_COLOURS[1]} radius={[3, 3, 0, 0]} maxBarSize={30} />
        <Line
          yAxisId="amount"
          type="monotone"
          dataKey="Amount"
          stroke={CHART_COLOURS[3]}
          strokeWidth={2}
          dot={{ r: 2.5 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/**
 * Utilization over time, as a percentage with the 30% CIBIL threshold marked.
 * Percentages, not rupees, so it gets its own tooltip rather than the money one.
 */
export function UtilizationTrendChart({
  data,
  height = 200,
}: {
  data: Array<{ label: string; percent: number; outstanding: Paise }>;
  height?: number;
}) {
  const max = Math.max(60, ...data.map((d) => d.percent)) * 1.1;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={data} margin={{ top: 8, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="util-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CHART_COLOURS[1]} stopOpacity={0.3} />
            <stop offset="100%" stopColor={CHART_COLOURS[1]} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="label" {...AXIS} />
        <YAxis domain={[0, max]} tickFormatter={(v: number) => `${Math.round(v)}%`} {...AXIS} />
        <RechartsTooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as { percent: number; outstanding: Paise } | undefined;
            if (!row) return null;
            return (
              <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] px-3 py-2 text-xs shadow-lg">
                <p className="mb-1 font-medium">{String(label)}</p>
                <p className="tnum">{row.percent.toFixed(1)}% utilized</p>
                <p className="tnum text-[var(--color-muted-foreground)]">
                  {formatINR(row.outstanding)} outstanding
                </p>
              </div>
            );
          }}
        />
        {/* The line CIBIL starts caring about. */}
        <ReferenceLine
          y={30}
          stroke={CHART_COLOURS[3]}
          strokeDasharray="4 4"
          label={{ value: '30%', position: 'right', fontSize: 10, fill: 'var(--color-muted-foreground)' }}
        />
        <Area
          type="monotone"
          dataKey="percent"
          stroke={CHART_COLOURS[1]}
          strokeWidth={2}
          fill="url(#util-fill)"
          dot={{ r: 2.5 }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/** Debt balance falling over time — the payoff planner's headline picture. */
export function BalanceOverTimeChart({
  series,
  height = 260,
}: {
  series: Array<{ name: string; colour: string; points: Array<{ month: number; balance: Paise }> }>;
  height?: number;
}) {
  const rows = React.useMemo(() => {
    const maxMonths = Math.max(0, ...series.map((s) => s.points.length));
    return Array.from({ length: maxMonths }, (_, i) => {
      const row: Record<string, number> = { month: i + 1 };
      for (const s of series) {
        const point = s.points[i];
        if (point) row[s.name] = toRupees(point.balance);
      }
      return row;
    });
  }, [series]);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={rows} margin={{ top: 8, right: 4, left: -16, bottom: 0 }}>
        <defs>
          {series.map((s) => (
            <linearGradient key={s.name} id={`grad-${s.name}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.colour} stopOpacity={0.35} />
              <stop offset="100%" stopColor={s.colour} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
        <XAxis dataKey="month" tickFormatter={(m) => `M${m}`} {...AXIS} />
        <YAxis tickFormatter={(v) => formatCompactINR(Math.round(v * 100), { noSymbol: true })} {...AXIS} />
        <RechartsTooltip
          content={<MoneyTooltip />}
          labelFormatter={(label) => `Month ${String(label)}`}
        />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 8 }} iconType="circle" iconSize={7} />
        {series.map((s) => (
          <Area
            key={s.name}
            type="monotone"
            dataKey={s.name}
            stroke={s.colour}
            strokeWidth={2}
            fill={`url(#grad-${s.name})`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
