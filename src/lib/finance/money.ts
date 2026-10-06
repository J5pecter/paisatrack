/**
 * Money primitives.
 *
 * Every rupee amount in PaisaTrack is an integer number of paise. Addition and
 * subtraction of integers is exact in JS up to Number.MAX_SAFE_INTEGER, which is
 * ~Rs 90,071,99,25,47,409 - far beyond any personal balance sheet. Anything that
 * multiplies or divides (interest rates, percentages, splits) goes through big.js
 * so no binary-float error can ever creep into a balance.
 */
import Big from 'big.js';
import type { Paise } from '@/types';

// Round half-up, matching how Indian banks round to the paise.
Big.RM = Big.roundHalfUp;
// Allow plenty of headroom for intermediate interest calculations.
Big.DP = 20;

export const ZERO: Paise = 0;
export const ONE_RUPEE: Paise = 100;

/** Convert rupees (number or decimal string) to integer paise. */
export function toPaise(rupees: number | string): Paise {
  if (rupees === '' || rupees === null || rupees === undefined) return 0;
  const n = new Big(rupees).times(100).round(0, Big.roundHalfUp);
  return Number(n);
}

/** Convert integer paise to a rupee number. Only for display and chart axes. */
export function toRupees(paise: Paise): number {
  return Number(new Big(paise).div(100));
}

/** Exact rupee string with two decimals, e.g. "1234.56". Use for CSV export. */
export function toRupeeString(paise: Paise): string {
  return new Big(paise).div(100).toFixed(2);
}

export function addMoney(...amounts: Paise[]): Paise {
  let total = 0;
  for (const a of amounts) total += Math.round(a);
  return total;
}

export function subMoney(a: Paise, b: Paise): Paise {
  return Math.round(a) - Math.round(b);
}

export function sumMoney(amounts: Paise[]): Paise {
  let total = 0;
  for (const a of amounts) total += Math.round(a);
  return total;
}

export function negate(a: Paise): Paise {
  return -a;
}

export function absMoney(a: Paise): Paise {
  return Math.abs(a);
}

/** Never let a balance go below zero (payments can overshoot). */
export function clampZero(a: Paise): Paise {
  return a < 0 ? 0 : a;
}

export function maxMoney(...amounts: Paise[]): Paise {
  return amounts.reduce((m, a) => (a > m ? a : m), Number.NEGATIVE_INFINITY);
}

export function minMoney(...amounts: Paise[]): Paise {
  return amounts.reduce((m, a) => (a < m ? a : m), Number.POSITIVE_INFINITY);
}

/**
 * Multiply an amount by an arbitrary factor (a rate, a fraction of a month),
 * rounding to the nearest paisa. All interest maths funnels through here.
 */
export function mulMoney(paise: Paise, factor: number | string): Paise {
  return Number(new Big(paise).times(factor).round(0, Big.roundHalfUp));
}

/** Divide an amount, rounding to the nearest paisa. */
export function divMoney(paise: Paise, divisor: number | string): Paise {
  if (Number(divisor) === 0) throw new Error('divMoney: division by zero');
  return Number(new Big(paise).div(divisor).round(0, Big.roundHalfUp));
}

/** `pct` percent of `paise`. pctOf(100000, 5) === 5000 (5% of Rs 1000 = Rs 50). */
export function pctOf(paise: Paise, pct: number): Paise {
  return Number(new Big(paise).times(pct).div(100).round(0, Big.roundHalfUp));
}

/** What percentage is `part` of `whole`? Returns a plain number, e.g. 42.7. */
export function percentage(part: Paise, whole: Paise, decimals = 2): number {
  if (whole === 0) return 0;
  return Number(new Big(part).times(100).div(whole).round(decimals, Big.roundHalfUp));
}

/**
 * Split an amount across weights without losing or inventing a single paisa.
 * Uses the largest-remainder method, so the parts always sum exactly to `total`.
 */
export function allocate(total: Paise, weights: number[]): Paise[] {
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (weightSum === 0) return weights.map(() => 0);

  const exact = weights.map((w) => new Big(total).times(w).div(weightSum));
  const floors = exact.map((e) => Number(e.round(0, Big.roundDown)));
  let remainder = total - floors.reduce((s, f) => s + f, 0);

  // Hand the leftover paise to the largest fractional parts first.
  const order = exact
    .map((e, i) => ({ i, frac: Number(e.minus(floors[i])) }))
    .sort((a, b) => b.frac - a.frac);

  const out = [...floors];
  let k = 0;
  while (remainder > 0 && order.length > 0) {
    out[order[k % order.length].i] += 1;
    remainder -= 1;
    k += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Formatting (Indian conventions)
// ---------------------------------------------------------------------------

const inrFull = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const inrWhole = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const numIN = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

export interface FormatOptions {
  /** Show paise. Default false - personal finance reads better in whole rupees. */
  paise?: boolean;
  /** Abbreviate large amounts as K / L / Cr. */
  compact?: boolean;
  /** Always show a leading + or -. */
  showSign?: boolean;
  /** Drop the currency symbol. */
  noSymbol?: boolean;
}

/**
 * Format paise using Indian digit grouping (lakh/crore), e.g.
 *   formatINR(123456789)             -> "Rs 12,34,568"   (symbol is the real glyph)
 *   formatINR(123456789, {paise:true}) -> "Rs 12,34,567.89"
 *   formatINR(123456789, {compact:true}) -> "Rs 12.35L"
 */
export function formatINR(paise: Paise, opts: FormatOptions = {}): string {
  const { paise: showPaise = false, compact = false, showSign = false, noSymbol = false } = opts;

  if (compact) return formatCompactINR(paise, { showSign, noSymbol });

  const rupees = toRupees(paise);
  const abs = Math.abs(rupees);
  const fmt = showPaise ? inrFull : inrWhole;

  let body = noSymbol ? numINFormat(abs, showPaise) : fmt.format(abs);
  if (showSign) body = (paise < 0 ? '-' : '+') + body;
  else if (paise < 0) body = '-' + body;
  return body;
}

function numINFormat(absRupees: number, showPaise: boolean): string {
  return showPaise
    ? new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(absRupees)
    : numIN.format(absRupees);
}

/**
 * Abbreviate with Indian scale words: Rs 1.2L, Rs 1.2Cr, Rs 12.5K.
 * Thresholds follow how Indians actually speak about money: under Rs 1,000 stays
 * exact, thousands become K, a lakh and above becomes L, a crore becomes Cr.
 */
export function formatCompactINR(
  paise: Paise,
  opts: { showSign?: boolean; noSymbol?: boolean } = {},
): string {
  const { showSign = false, noSymbol = false } = opts;
  const symbol = noSymbol ? '' : '₹';
  const rupees = Math.abs(toRupees(paise));

  let body: string;
  if (rupees >= 1_00_00_000) body = `${symbol}${trimZeros(rupees / 1_00_00_000)}Cr`;
  else if (rupees >= 1_00_000) body = `${symbol}${trimZeros(rupees / 1_00_000)}L`;
  else if (rupees >= 1_000) body = `${symbol}${trimZeros(rupees / 1_000)}K`;
  else body = `${symbol}${Math.round(rupees)}`;

  if (showSign) return (paise < 0 ? '-' : '+') + body;
  return (paise < 0 ? '-' : '') + body;
}

function trimZeros(n: number): string {
  // 1.20 -> "1.2", 1.00 -> "1", 12.35 -> "12.35"
  const s = n.toFixed(n < 10 ? 2 : 1);
  return s.replace(/\.?0+$/, '');
}

/** Plain Indian-grouped integer, no currency symbol. For units, counts, etc. */
export function formatNumberIN(n: number, decimals = 0): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

/** "8.5%" / "8.50%" */
export function formatPercent(pct: number, decimals = 2): string {
  return `${pct.toFixed(decimals).replace(/\.?0+$/, (m) => (decimals === 0 ? '' : m === '.00' ? '' : m))}%`;
}

/**
 * Parse loose user input into paise. Accepts "1,234.56", "Rs 1234", "1.2L",
 * "2.5cr", "12k", "  450 ". Returns null when the input is not a number.
 */
export function parseINR(input: string): Paise | null {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (!s) return null;

  s = s.replace(/[₹]|rs\.?|inr/g, '').replace(/,/g, '').replace(/\s+/g, '');

  let multiplier = new Big(1);
  const suffix = s.match(/(cr|crore|crores|l|lac|lakh|lakhs|k|thousand)$/);
  if (suffix) {
    const u = suffix[1];
    if (u.startsWith('cr')) multiplier = new Big(1_00_00_000);
    else if (u === 'k' || u === 'thousand') multiplier = new Big(1_000);
    else multiplier = new Big(1_00_000);
    s = s.slice(0, -u.length);
  }

  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '.' || s === '-') return null;

  try {
    return Number(new Big(s).times(multiplier).times(100).round(0, Big.roundHalfUp));
  } catch {
    return null;
  }
}
