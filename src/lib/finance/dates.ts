/**
 * Date helpers for billing cycles, statements and due dates.
 *
 * Everything here works in *calendar days* at local midnight. Credit card
 * interest is charged per whole day, so any time-of-day component would only
 * introduce off-by-one errors. `toDate()` normalises aggressively.
 */
import {
  addDays,
  addMonths,
  differenceInCalendarDays,
  endOfMonth,
  format,
  isAfter,
  isBefore,
  isSameDay,
  parseISO,
  startOfDay,
  startOfMonth,
} from 'date-fns';
import type { ISODate, MonthKey } from '@/types';

export type DateLike = Date | ISODate;

/** Normalise anything date-ish to local midnight. */
export function toDate(d: DateLike): Date {
  const parsed = typeof d === 'string' ? parseISO(d) : d;
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${String(d)}`);
  return startOfDay(parsed);
}

/** "2026-09-30" */
export function toISODate(d: DateLike): ISODate {
  return format(toDate(d), 'yyyy-MM-dd');
}

/** "2026-09" */
export function monthKey(d: DateLike): MonthKey {
  return format(toDate(d), 'yyyy-MM');
}

export function monthKeyToDate(key: MonthKey): Date {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1);
}

/** "Sep 2026" */
export function formatMonthKey(key: MonthKey): string {
  return format(monthKeyToDate(key), 'MMM yyyy');
}

/** "30 Sep 2026" */
export function formatDate(d: DateLike): string {
  return format(toDate(d), 'dd MMM yyyy');
}

/** "30 Sep" */
export function formatDateShort(d: DateLike): string {
  return format(toDate(d), 'dd MMM');
}

export function todayISO(): ISODate {
  return toISODate(new Date());
}

/** Whole calendar days from a to b. Negative when b precedes a. */
export function daysBetween(a: DateLike, b: DateLike): number {
  return differenceInCalendarDays(toDate(b), toDate(a));
}

export function daysInMonth(d: DateLike): number {
  return endOfMonth(toDate(d)).getDate();
}

/**
 * The `day`-th of the month containing `ref`, clamped to the month length so
 * "statement on the 31st" resolves to the 28th/29th in February rather than
 * silently rolling into March.
 */
export function dayOfMonthClamped(ref: DateLike, day: number): Date {
  const base = toDate(ref);
  const last = endOfMonth(base).getDate();
  const clamped = Math.min(Math.max(1, Math.trunc(day)), last);
  return startOfDay(new Date(base.getFullYear(), base.getMonth(), clamped));
}

/** Add whole months, clamping the day to the target month length. */
export function addMonthsClamped(d: DateLike, months: number): Date {
  return startOfDay(addMonths(toDate(d), months));
}

// ---------------------------------------------------------------------------
// Credit card cycle helpers
// ---------------------------------------------------------------------------

/** The most recent statement date on or before `ref`. */
export function currentStatementDate(ref: DateLike, statementDay: number): Date {
  const base = toDate(ref);
  const thisMonth = dayOfMonthClamped(base, statementDay);
  if (!isAfter(thisMonth, base)) return thisMonth;
  return dayOfMonthClamped(addMonths(base, -1), statementDay);
}

/** The next statement date strictly after `ref`. */
export function nextStatementDate(ref: DateLike, statementDay: number): Date {
  const base = toDate(ref);
  const thisMonth = dayOfMonthClamped(base, statementDay);
  if (isAfter(thisMonth, base)) return thisMonth;
  return dayOfMonthClamped(addMonths(base, 1), statementDay);
}

/**
 * The payment due date for a statement.
 *
 * Indian cards give roughly 15-25 days after the statement. If `dueDay` falls
 * on or before the statement day it belongs to the following month; otherwise
 * it is in the same month. This mirrors how issuers actually set the cycle
 * (e.g. statement on the 18th, due on the 8th -> next month).
 */
export function dueDateFor(statementDate: DateLike, dueDay: number): Date {
  const stmt = toDate(statementDate);
  const sameMonth = dayOfMonthClamped(stmt, dueDay);
  if (isAfter(sameMonth, stmt)) return sameMonth;
  return dayOfMonthClamped(addMonths(stmt, 1), dueDay);
}

/** The statement date immediately preceding `statementDate`. */
export function previousStatementDate(statementDate: DateLike, statementDay: number): Date {
  return dayOfMonthClamped(addMonths(toDate(statementDate), -1), statementDay);
}

/** Inclusive-of-end day count for a billing cycle (prev statement -> statement). */
export function cycleDays(previous: DateLike, current: DateLike): number {
  return daysBetween(previous, current);
}

// ---------------------------------------------------------------------------
// Due-date status
// ---------------------------------------------------------------------------

export function isOverdue(dueDate: DateLike, asOf: DateLike = new Date()): boolean {
  return isBefore(toDate(dueDate), toDate(asOf));
}

export function isDueToday(dueDate: DateLike, asOf: DateLike = new Date()): boolean {
  return isSameDay(toDate(dueDate), toDate(asOf));
}

/** Negative = overdue by N days, 0 = due today, positive = N days remaining. */
export function daysUntilDue(dueDate: DateLike, asOf: DateLike = new Date()): number {
  return daysBetween(asOf, dueDate);
}

export type DueUrgency = 'OVERDUE' | 'TODAY' | 'CRITICAL' | 'SOON' | 'UPCOMING';

/** Urgency bucket driving the red/amber/neutral badges across the UI. */
export function dueUrgency(dueDate: DateLike, asOf: DateLike = new Date()): DueUrgency {
  const d = daysUntilDue(dueDate, asOf);
  if (d < 0) return 'OVERDUE';
  if (d === 0) return 'TODAY';
  if (d <= 3) return 'CRITICAL';
  if (d <= 7) return 'SOON';
  return 'UPCOMING';
}

/** "Overdue by 4 days" / "Due today" / "Due in 2 days" */
export function dueLabel(dueDate: DateLike, asOf: DateLike = new Date()): string {
  const d = daysUntilDue(dueDate, asOf);
  if (d < 0) return `Overdue by ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'}`;
  if (d === 0) return 'Due today';
  if (d === 1) return 'Due tomorrow';
  return `Due in ${d} days`;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export function monthRange(key: MonthKey): { start: Date; end: Date } {
  const start = monthKeyToDate(key);
  return { start: startOfMonth(start), end: endOfMonth(start) };
}

/** Is `d` inside [start, end], inclusive on both ends? */
export function isWithin(d: DateLike, start: DateLike, end: DateLike): boolean {
  const t = toDate(d).getTime();
  return t >= toDate(start).getTime() && t <= toDate(end).getTime();
}

/** The last `count` month keys ending at `end`, oldest first. */
export function lastNMonths(count: number, end: DateLike = new Date()): MonthKey[] {
  const base = toDate(end);
  const out: MonthKey[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(monthKey(addMonths(base, -i)));
  return out;
}

/** Days left in the month containing `ref`, counting today. */
export function daysLeftInMonth(ref: DateLike = new Date()): number {
  const d = toDate(ref);
  return daysBetween(d, endOfMonth(d)) + 1;
}

/** Indian financial year label for a date, e.g. "FY 2026-27". */
export function financialYearLabel(d: DateLike, startMonth = 4): string {
  const date = toDate(d);
  const y = date.getFullYear();
  const startYear = date.getMonth() + 1 >= startMonth ? y : y - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** The month keys of a financial year, oldest first. */
export function financialYearMonths(startYear: number, startMonth = 4): MonthKey[] {
  const out: MonthKey[] = [];
  const base = new Date(startYear, startMonth - 1, 1);
  for (let i = 0; i < 12; i++) out.push(monthKey(addMonths(base, i)));
  return out;
}

export { addDays, addMonths, startOfMonth, endOfMonth, isAfter, isBefore, isSameDay };
