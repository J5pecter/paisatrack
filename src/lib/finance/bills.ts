/**
 * Recurring bills: which bills fall due in a given month, and the
 * electricity-specific unit maths.
 */
import Big from 'big.js';
import type {
  Bill,
  BillEntry,
  BillEntryStatus,
  ISODate,
  MonthKey,
  Paise,
} from '@/types';
import {
  dayOfMonthClamped,
  isOverdue,
  monthKey,
  monthKeyToDate,
  toISODate,
} from './dates';
import { divMoney, sumMoney } from './money';

/**
 * Does a bill fall due in this month?
 *
 * MONTHLY always does. QUARTERLY falls due every third month counting from
 * `anchorMonth`, ANNUAL only in `anchorMonth`. When no anchor is set we fall
 * back to the month the bill was created.
 */
export function billFallsDueIn(bill: Bill, month: MonthKey): boolean {
  if (!bill.isActive) return false;

  const target = monthKeyToDate(month);
  const targetMonth = target.getMonth() + 1;

  const anchor = bill.anchorMonth ?? new Date(bill.createdAt).getMonth() + 1;

  switch (bill.frequency) {
    case 'MONTHLY':
      return true;
    case 'QUARTERLY':
      return (((targetMonth - anchor) % 3) + 3) % 3 === 0;
    case 'ANNUAL':
      return targetMonth === anchor;
  }
}

/** The due date for a bill in a given month, clamped to the month length. */
export function billDueDate(bill: Bill, month: MonthKey): ISODate {
  return toISODate(dayOfMonthClamped(monthKeyToDate(month), bill.dueDay));
}

/**
 * Create the BillEntry rows for a month, skipping bills that already have one.
 * FIXED bills prefill their default amount; VARIABLE bills start at zero so the
 * user is prompted to enter the real figure.
 */
export function generateMonthlyBillEntries(
  bills: Bill[],
  month: MonthKey,
  existing: BillEntry[] = [],
  now: Date = new Date(),
): Array<Omit<BillEntry, 'id' | 'createdAt' | 'updatedAt'>> {
  const already = new Set(
    existing.filter((e) => e.billingMonth === month).map((e) => e.billId),
  );

  return bills
    .filter((b) => billFallsDueIn(b, month) && !already.has(b.id))
    .map((bill) => {
      const dueDate = billDueDate(bill, month);
      const status: BillEntryStatus = bill.isAutopay
        ? 'PENDING'
        : isOverdue(dueDate, now)
          ? 'OVERDUE'
          : 'PENDING';
      return {
        billId: bill.id,
        billingMonth: month,
        amount: bill.type === 'FIXED' ? bill.defaultAmount : 0,
        dueDate,
        paidOn: null,
        status,
      };
    });
}

/** Recompute a bill entry's status against today. */
export function billEntryStatus(entry: BillEntry, now: Date = new Date()): BillEntryStatus {
  if (entry.status === 'SKIPPED') return 'SKIPPED';
  if (entry.paidOn) return 'PAID';
  return isOverdue(entry.dueDate, now) ? 'OVERDUE' : 'PENDING';
}

// ---------------------------------------------------------------------------
// Electricity
// ---------------------------------------------------------------------------

/** Cost per unit in paise. Returns 0 when units are unknown. */
export function calculateElectricityRate(units: number, amount: Paise): Paise {
  if (!units || units <= 0) return 0;
  return Number(new Big(amount).div(units).round(0, Big.roundHalfUp));
}

export interface ElectricityPoint {
  month: MonthKey;
  units: number;
  amount: Paise;
  ratePerUnit: Paise;
}

/**
 * Build the 12-month units + amount series for the electricity chart, so a
 * spike in consumption is obvious at a glance.
 */
export function electricitySeries(entries: BillEntry[], months: MonthKey[]): ElectricityPoint[] {
  const byMonth = new Map<MonthKey, BillEntry[]>();
  for (const e of entries) {
    const list = byMonth.get(e.billingMonth) ?? [];
    list.push(e);
    byMonth.set(e.billingMonth, list);
  }

  return months.map((m) => {
    const rows = byMonth.get(m) ?? [];
    const units = rows.reduce((s, r) => s + (r.unitsConsumed ?? 0), 0);
    const amount = sumMoney(rows.map((r) => r.amount));
    return { month: m, units, amount, ratePerUnit: calculateElectricityRate(units, amount) };
  });
}

/** Flag a month whose consumption is well above the trailing average. */
export function detectConsumptionSpike(
  series: ElectricityPoint[],
  thresholdPercent = 30,
): { month: MonthKey; units: number; averageUnits: number; increasePercent: number } | null {
  const withUnits = series.filter((p) => p.units > 0);
  if (withUnits.length < 3) return null;

  const latest = withUnits[withUnits.length - 1];
  const prior = withUnits.slice(0, -1);
  const average = prior.reduce((s, p) => s + p.units, 0) / prior.length;
  if (average <= 0) return null;

  const increase = ((latest.units - average) / average) * 100;
  if (increase < thresholdPercent) return null;

  return {
    month: latest.month,
    units: latest.units,
    averageUnits: Math.round(average),
    increasePercent: Math.round(increase),
  };
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/** Total committed outflow for a month's bills, whether paid or not. */
export function monthlyBillTotal(entries: BillEntry[], month: MonthKey): Paise {
  return sumMoney(
    entries.filter((e) => e.billingMonth === month && e.status !== 'SKIPPED').map((e) => e.amount),
  );
}

export function unpaidBillTotal(entries: BillEntry[], month: MonthKey): Paise {
  return sumMoney(
    entries
      .filter((e) => e.billingMonth === month && (e.status === 'PENDING' || e.status === 'OVERDUE'))
      .map((e) => e.amount),
  );
}

/**
 * Average monthly cost of a bill, normalised across frequencies, so quarterly
 * and annual bills contribute their fair share to the monthly budget.
 */
export function normalisedMonthlyCost(bill: Bill): Paise {
  switch (bill.frequency) {
    case 'MONTHLY': return bill.defaultAmount;
    case 'QUARTERLY': return divMoney(bill.defaultAmount, 3);
    case 'ANNUAL': return divMoney(bill.defaultAmount, 12);
  }
}

/** Total fixed monthly commitment across all active bills. */
export function totalMonthlyCommitment(bills: Bill[]): Paise {
  return sumMoney(bills.filter((b) => b.isActive).map(normalisedMonthlyCost));
}

/** Bills due within the next `days` days, soonest first. */
export function upcomingBills(
  bills: Bill[],
  entries: BillEntry[],
  days = 30,
  now: Date = new Date(),
): Array<{ bill: Bill; entry: BillEntry }> {
  const byId = new Map(bills.map((b) => [b.id, b]));
  const horizon = new Date(now);
  horizon.setDate(horizon.getDate() + days);

  return entries
    .filter((e) => e.status === 'PENDING' || e.status === 'OVERDUE')
    .map((e) => ({ bill: byId.get(e.billId), entry: e }))
    .filter((x): x is { bill: Bill; entry: BillEntry } => Boolean(x.bill))
    .filter((x) => new Date(x.entry.dueDate) <= horizon)
    .sort((a, b) => a.entry.dueDate.localeCompare(b.entry.dueDate));
}

/** The month key a bill entry belongs to, for grouping. */
export function entryMonth(entry: BillEntry): MonthKey {
  return entry.billingMonth || monthKey(entry.dueDate);
}
