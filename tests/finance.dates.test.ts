import { describe, expect, it } from 'vitest';
import {
  currentStatementDate,
  dayOfMonthClamped,
  daysBetween,
  daysLeftInMonth,
  daysUntilDue,
  dueDateFor,
  dueLabel,
  dueUrgency,
  financialYearLabel,
  financialYearMonths,
  isOverdue,
  lastNMonths,
  monthKey,
  nextStatementDate,
  toISODate,
} from '@/lib/finance/dates';

describe('day counting', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-04-10', '2026-05-12')).toBe(32); // the HDFC example
    expect(daysBetween('2026-04-18', '2026-05-18')).toBe(30);
    expect(daysBetween('2026-05-18', '2026-04-18')).toBe(-30);
    expect(daysBetween('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('handles leap years', () => {
    expect(daysBetween('2028-02-01', '2028-03-01')).toBe(29);
    expect(daysBetween('2026-02-01', '2026-03-01')).toBe(28);
  });
});

describe('day-of-month clamping', () => {
  it('clamps the 31st to the end of a short month', () => {
    expect(toISODate(dayOfMonthClamped('2026-02-10', 31))).toBe('2026-02-28');
    expect(toISODate(dayOfMonthClamped('2028-02-10', 31))).toBe('2028-02-29');
    expect(toISODate(dayOfMonthClamped('2026-04-10', 31))).toBe('2026-04-30');
    expect(toISODate(dayOfMonthClamped('2026-01-10', 31))).toBe('2026-01-31');
  });

  it('clamps out-of-range days rather than rolling over', () => {
    expect(toISODate(dayOfMonthClamped('2026-03-15', 0))).toBe('2026-03-01');
    expect(toISODate(dayOfMonthClamped('2026-03-15', 99))).toBe('2026-03-31');
  });
});

describe('statement cycle', () => {
  it('finds the current statement date', () => {
    expect(toISODate(currentStatementDate('2026-04-20', 18))).toBe('2026-04-18');
    expect(toISODate(currentStatementDate('2026-04-10', 18))).toBe('2026-03-18');
    expect(toISODate(currentStatementDate('2026-04-18', 18))).toBe('2026-04-18');
  });

  it('finds the next statement date', () => {
    expect(toISODate(nextStatementDate('2026-04-10', 18))).toBe('2026-04-18');
    expect(toISODate(nextStatementDate('2026-04-18', 18))).toBe('2026-05-18');
  });

  it('puts the due date in the following month when it precedes the statement day', () => {
    // Statement on the 18th, due on the 8th -> the 8th of the next month.
    expect(toISODate(dueDateFor('2026-04-18', 8))).toBe('2026-05-08');
    // Statement on the 2nd, due on the 22nd -> the same month.
    expect(toISODate(dueDateFor('2026-04-02', 22))).toBe('2026-04-22');
  });

  it('clamps the due date in February', () => {
    expect(toISODate(dueDateFor('2026-01-31', 30))).toBe('2026-02-28');
  });
});

describe('due-date status', () => {
  const today = '2026-06-15';

  it('counts days until due', () => {
    expect(daysUntilDue('2026-06-20', today)).toBe(5);
    expect(daysUntilDue('2026-06-15', today)).toBe(0);
    expect(daysUntilDue('2026-06-11', today)).toBe(-4);
  });

  it('buckets urgency the way the badges do', () => {
    expect(dueUrgency('2026-06-11', today)).toBe('OVERDUE');
    expect(dueUrgency('2026-06-15', today)).toBe('TODAY');
    expect(dueUrgency('2026-06-17', today)).toBe('CRITICAL'); // <= 3 days
    expect(dueUrgency('2026-06-21', today)).toBe('SOON');     // <= 7 days
    expect(dueUrgency('2026-07-15', today)).toBe('UPCOMING');
  });

  it('labels the way a human would say it', () => {
    expect(dueLabel('2026-06-11', today)).toBe('Overdue by 4 days');
    expect(dueLabel('2026-06-14', today)).toBe('Overdue by 1 day');
    expect(dueLabel('2026-06-15', today)).toBe('Due today');
    expect(dueLabel('2026-06-16', today)).toBe('Due tomorrow');
    expect(dueLabel('2026-06-20', today)).toBe('Due in 5 days');
  });

  it('knows what is overdue', () => {
    expect(isOverdue('2026-06-14', today)).toBe(true);
    expect(isOverdue('2026-06-15', today)).toBe(false); // due today is not late
    expect(isOverdue('2026-06-16', today)).toBe(false);
  });
});

describe('month helpers', () => {
  it('builds month keys', () => {
    expect(monthKey('2026-09-30')).toBe('2026-09');
    expect(monthKey('2026-01-01')).toBe('2026-01');
  });

  it('lists the last N months oldest first', () => {
    expect(lastNMonths(3, '2026-03-15')).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(lastNMonths(3, '2026-01-15')).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('counts days left in the month, today included', () => {
    expect(daysLeftInMonth('2026-06-30')).toBe(1);
    expect(daysLeftInMonth('2026-06-01')).toBe(30);
  });
});

describe('Indian financial year', () => {
  it('runs April to March', () => {
    expect(financialYearLabel('2026-04-01')).toBe('FY 2026-27');
    expect(financialYearLabel('2026-03-31')).toBe('FY 2025-26');
    expect(financialYearLabel('2026-12-31')).toBe('FY 2026-27');
  });

  it('lists the twelve months of a financial year', () => {
    const months = financialYearMonths(2026);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2026-04');
    expect(months[11]).toBe('2027-03');
  });
});
