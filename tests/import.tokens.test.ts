/**
 * Reading dates and amounts off a statement.
 *
 * These are the two primitives every parser stands on, so they are tested
 * against the formats real Indian statements actually use rather than against
 * a tidy invented one. Getting a date convention wrong here would shift a
 * transaction by a month without any error, which is the failure mode this
 * file exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  directionFromText,
  findAmounts,
  findDate,
  parseIndianAmount,
  parseLooseDate,
  squash,
} from '@/lib/import/tokens';

describe('parseLooseDate', () => {
  it('reads the shapes Indian banks print', () => {
    expect(parseLooseDate('01/04/2026')).toBe('2026-04-01');
    expect(parseLooseDate('01-04-2026')).toBe('2026-04-01');
    expect(parseLooseDate('01.04.2026')).toBe('2026-04-01');
    expect(parseLooseDate('15-Mar-2026')).toBe('2026-03-15');
    expect(parseLooseDate('15 Mar 2026')).toBe('2026-03-15');
    expect(parseLooseDate('2026-04-01')).toBe('2026-04-01');
  });

  it('reads the shape the UPI apps print', () => {
    expect(parseLooseDate('Mar 15, 2026')).toBe('2026-03-15');
    expect(parseLooseDate('March 15 2026')).toBe('2026-03-15');
  });

  it('assumes DAY first for all-numeric dates', () => {
    // 03/04 is 3 April in India and 4 March in the US. Reading it the American
    // way would move the transaction a month with no error raised, so the
    // convention is pinned here deliberately.
    expect(parseLooseDate('03/04/2026')).toBe('2026-04-03');
  });

  it('expands a two-digit year into the past, never the future', () => {
    // A statement records what already happened, so "99" cannot be 2099.
    expect(parseLooseDate('01-04-26')).toBe('2026-04-01');
    expect(parseLooseDate('01-04-99')).toBe('1999-04-01');
  });

  it('rejects a day that does not exist', () => {
    expect(parseLooseDate('31/04/2026')).toBeNull(); // April has 30
    expect(parseLooseDate('30/02/2026')).toBeNull();
    expect(parseLooseDate('29/02/2025')).toBeNull(); // not a leap year
  });

  it('accepts the leap day in a leap year', () => {
    expect(parseLooseDate('29/02/2028')).toBe('2028-02-29');
  });

  it('returns null for anything it cannot read, rather than guessing', () => {
    expect(parseLooseDate('')).toBeNull();
    expect(parseLooseDate('Opening Balance')).toBeNull();
    expect(parseLooseDate('12345678')).toBeNull();
  });
});

describe('findDate', () => {
  it('finds the date inside a transaction line', () => {
    const r = findDate('01/04/2026  UPI-SWIGGY-9876  450.00  12,345.67');
    expect(r?.date).toBe('2026-04-01');
    expect(r?.index).toBe(0);
  });

  it('skips a number that merely looks date-ish', () => {
    const r = findDate('Ref 999999999 on 15-Mar-2026 for groceries');
    expect(r?.date).toBe('2026-03-15');
  });

  it('returns null on a line with no date', () => {
    expect(findDate('Closing Balance 1,23,456.78')).toBeNull();
  });
});

describe('parseIndianAmount', () => {
  it('reads Indian digit grouping', () => {
    // Lakh grouping is 2-2-3, not the 3-3-3 most parsers assume.
    expect(parseIndianAmount('1,23,456.78')).toBe(1_23_456_78);
    expect(parseIndianAmount('12,345.67')).toBe(12_345_67);
    expect(parseIndianAmount('450.00')).toBe(45_000);
  });

  it('strips the rupee sign, INR and spaces', () => {
    expect(parseIndianAmount('₹ 1,000.00')).toBe(1_00_000);
    expect(parseIndianAmount('INR 500.50')).toBe(50_050);
  });

  it('reads the accounting bracket as negative', () => {
    expect(parseIndianAmount('(1,500.00)')).toBe(-1_50_000);
  });

  it('ignores a trailing Dr or Cr marker', () => {
    // The marker is direction, handled separately — not part of the number.
    expect(parseIndianAmount('2,500.00 Cr')).toBe(2_50_000);
    expect(parseIndianAmount('2,500.00Dr')).toBe(2_50_000);
  });

  it('returns null, not zero, for unreadable input', () => {
    // Zero would silently become a real transaction worth nothing.
    expect(parseIndianAmount('')).toBeNull();
    expect(parseIndianAmount('N/A')).toBeNull();
    expect(parseIndianAmount('abc')).toBeNull();
  });

  it('rounds to the paisa rather than truncating', () => {
    expect(parseIndianAmount('123.45')).toBe(12_345);
    expect(parseIndianAmount('0.01')).toBe(1);
  });
});

describe('findAmounts', () => {
  it('finds every amount on a statement line, in order', () => {
    const got = findAmounts('01/04/2026 UPI-SWIGGY 450.00 12,345.67');
    expect(got.map((a) => a.value)).toEqual([45_000, 12_345_67]);
  });

  it('does not mistake a reference number for money', () => {
    // A bare integer is a reference, an account number or a year. Money on a
    // statement always carries either a decimal or a grouping comma.
    const got = findAmounts('REF 123456789 dated 2026 amount 450.00');
    expect(got.map((a) => a.value)).toEqual([45_000]);
  });

  it('handles the rupee sign and Dr/Cr suffixes', () => {
    const got = findAmounts('Payment ₹1,500.00 Dr balance 20,000.00 Cr');
    expect(got.map((a) => a.value)).toEqual([1_50_000, 20_000_00]);
  });

  it('returns nothing for a line with no amounts', () => {
    expect(findAmounts('Statement of Account')).toEqual([]);
  });
});

describe('directionFromText', () => {
  it('reads explicit bank markers', () => {
    expect(directionFromText('NEFT 5,000.00 Cr')).toBe('CREDIT');
    expect(directionFromText('ATM WDL 2,000.00 Dr')).toBe('DEBIT');
  });

  it('reads the wording the UPI apps use', () => {
    expect(directionFromText('Paid to Swiggy')).toBe('DEBIT');
    expect(directionFromText('Received from Rahul')).toBe('CREDIT');
    expect(directionFromText('Cashback from PhonePe')).toBe('CREDIT');
  });

  it('returns null when the line says nothing either way', () => {
    // The caller then falls back to the running balance, which is better
    // evidence than any keyword.
    expect(directionFromText('01/04/2026 SWIGGY 450.00 12,345.67')).toBeNull();
  });
});

describe('squash', () => {
  it('collapses the ragged whitespace PDF extraction produces', () => {
    expect(squash('  UPI  -  SWIGGY   \n ORDER ')).toBe('UPI - SWIGGY ORDER');
  });
});
