import { describe, expect, it } from 'vitest';
import {
  allocate,
  addMoney,
  clampZero,
  divMoney,
  formatCompactINR,
  formatINR,
  mulMoney,
  parseINR,
  pctOf,
  percentage,
  subMoney,
  sumMoney,
  toPaise,
  toRupeeString,
  toRupees,
} from '@/lib/finance/money';

describe('paise conversion', () => {
  it('converts rupees to integer paise', () => {
    expect(toPaise(1234.56)).toBe(123456);
    expect(toPaise('1234.56')).toBe(123456);
    expect(toPaise(0)).toBe(0);
    expect(toPaise(1)).toBe(100);
  });

  it('rounds half-up at the paisa, never truncating money away', () => {
    expect(toPaise(0.005)).toBe(1);
    expect(toPaise(0.004)).toBe(0);
    expect(toPaise(99.999)).toBe(10000);
  });

  it('survives the classic float traps', () => {
    // 0.1 + 0.2 !== 0.3 in binary float; in paise it is exact.
    expect(addMoney(toPaise(0.1), toPaise(0.2))).toBe(toPaise(0.3));
    expect(toPaise(1.005)).toBe(101);
    // A long chain of additions must not drift.
    const hundredPaise = Array.from({ length: 100 }, () => toPaise(0.01));
    expect(sumMoney(hundredPaise)).toBe(toPaise(1));
  });

  it('round-trips back to rupees', () => {
    expect(toRupees(123456)).toBe(1234.56);
    expect(toRupeeString(123456)).toBe('1234.56');
    expect(toRupeeString(100)).toBe('1.00');
  });
});

describe('money arithmetic', () => {
  it('adds and subtracts exactly', () => {
    expect(addMoney(100, 250, 33)).toBe(383);
    expect(subMoney(1000, 250)).toBe(750);
    expect(clampZero(subMoney(100, 250))).toBe(0);
  });

  it('multiplies and divides with half-up rounding', () => {
    expect(mulMoney(10000, 0.5)).toBe(5000);
    expect(mulMoney(333, 0.5)).toBe(167); // 166.5 -> 167
    expect(divMoney(1000, 3)).toBe(333);
  });

  it('computes percentages', () => {
    expect(pctOf(100000, 5)).toBe(5000); // 5% of Rs 1000 = Rs 50
    expect(pctOf(100000, 18)).toBe(18000);
    expect(percentage(2500, 10000)).toBe(25);
    expect(percentage(1, 0)).toBe(0); // no divide-by-zero
  });
});

describe('allocate', () => {
  it('splits without losing or inventing a paisa', () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(sumMoney(parts)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
  });

  it('respects weights', () => {
    const parts = allocate(1000, [3, 1]);
    expect(sumMoney(parts)).toBe(1000);
    expect(parts).toEqual([750, 250]);
  });

  it('handles an awkward three-way split of a large sum', () => {
    const parts = allocate(1_00_00_001, [1, 1, 1]);
    expect(sumMoney(parts)).toBe(1_00_00_001);
  });

  it('returns zeros when all weights are zero', () => {
    expect(allocate(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('Indian formatting', () => {
  it('groups in lakhs and crores', () => {
    // Intl uses the narrow rupee sign; assert on the digits, not the glyph.
    expect(formatINR(1_00_00_000)).toContain('1,00,000');
    expect(formatINR(1_00_00_00_000)).toContain('1,00,00,000'); // Rs 1 crore
  });

  it('abbreviates the way Indians actually speak', () => {
    expect(formatCompactINR(toPaise(120000))).toBe('₹1.2L');
    expect(formatCompactINR(toPaise(12500000))).toBe('₹1.25Cr');
    expect(formatCompactINR(toPaise(12500))).toBe('₹12.5K');
    expect(formatCompactINR(toPaise(450))).toBe('₹450');
  });

  it('shows signs when asked', () => {
    expect(formatCompactINR(toPaise(-1200), { showSign: true })).toBe('-₹1.2K');
    expect(formatCompactINR(toPaise(1200), { showSign: true })).toBe('+₹1.2K');
  });
});

describe('parseINR', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseINR('1,234.56')).toBe(123456);
    expect(parseINR('₹1234')).toBe(123400);
    expect(parseINR('Rs 1234')).toBe(123400);
    expect(parseINR('  450 ')).toBe(45000);
    expect(parseINR('1.2L')).toBe(1_20_000_00);
    expect(parseINR('2.5cr')).toBe(2_50_00_000_00);
    expect(parseINR('12k')).toBe(12_000_00);
  });

  it('rejects nonsense instead of guessing', () => {
    expect(parseINR('abc')).toBeNull();
    expect(parseINR('')).toBeNull();
    expect(parseINR('.')).toBeNull();
    expect(parseINR('1.2.3')).toBeNull();
  });
});
