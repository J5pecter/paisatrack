/**
 * What leaves the device when reminders are on.
 *
 * `dueDates` is the entire upload. Everything the server is ever told about a
 * user's finances passes through this one function, so these tests are less
 * about correctness than about containment: if a future change makes it return
 * labels, amounts or ids "because the notification would be nicer", the
 * assertions below are what should stop it.
 */
import { describe, expect, it } from 'vitest';
import type { UpcomingDue } from '@/lib/finance/dashboard';
import { dueDates } from './index';

function due(partial: Partial<UpcomingDue>): UpcomingDue {
  return {
    id: 'due_1',
    kind: 'CARD',
    label: 'HDFC Regalia',
    sublabel: 'Minimum due',
    amount: 2_450_000,
    dueDate: '2026-10-18',
    daysUntil: 10,
    isOverdue: false,
    relatedId: 'card_1',
    ...partial,
  };
}

describe('dueDates', () => {
  it('returns dates and nothing else', () => {
    /*
      The assertion that matters. Every other field on an UpcomingDue —
      the payee, the rupee amount, the card it belongs to — is exactly what
      must not reach a server, and a plain array of date strings cannot carry
      any of it however the calling code changes.
    */
    const result = dueDates([due({})]);

    expect(result).toEqual(['2026-10-18']);
    expect(result.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('HDFC');
    expect(serialised).not.toContain('Regalia');
    expect(serialised).not.toContain('2450000');
    expect(serialised).not.toContain('card_1');
  });

  it('collapses several payments falling on one day', () => {
    // Three bills on the 18th are one morning's notification, not three.
    const result = dueDates([
      due({ id: 'a', dueDate: '2026-10-18' }),
      due({ id: 'b', dueDate: '2026-10-18', kind: 'BILL' }),
      due({ id: 'c', dueDate: '2026-10-18', kind: 'EMI' }),
    ]);
    expect(result).toEqual(['2026-10-18']);
  });

  it('sorts chronologically', () => {
    const result = dueDates([
      due({ id: 'a', dueDate: '2026-11-02', daysUntil: 25 }),
      due({ id: 'b', dueDate: '2026-10-05', daysUntil: 1 }),
      due({ id: 'c', dueDate: '2026-10-18', daysUntil: 10 }),
    ]);
    expect(result).toEqual(['2026-10-05', '2026-10-18', '2026-11-02']);
  });

  it('drops anything already overdue', () => {
    // An overdue payment is on the dashboard in red. A push about it is
    // nagging about the past, not a reminder.
    const result = dueDates([
      due({ id: 'a', dueDate: '2026-09-18', daysUntil: -12, isOverdue: true }),
      due({ id: 'b', dueDate: '2026-10-18' }),
    ]);
    expect(result).toEqual(['2026-10-18']);
  });

  it('drops anything past the 90-day horizon', () => {
    const result = dueDates([
      due({ id: 'a', dueDate: '2027-06-01', daysUntil: 236 }),
      due({ id: 'b', dueDate: '2026-10-18' }),
    ]);
    expect(result).toEqual(['2026-10-18']);
  });

  it('is empty when nothing is due, rather than throwing', () => {
    // A user with no cards, loans or bills still switches reminders on, and
    // should get "nothing is due" rather than an error.
    expect(dueDates([])).toEqual([]);
  });
});
