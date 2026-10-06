import { describe, expect, it } from 'vitest';
import {
  calculateEMI,
  generateAmortization,
  outstandingAfter,
  simulatePrepayment,
  tenureForEMI,
  totalInterestOnLoan,
} from '@/lib/finance/emi';
import { toPaise, toRupees } from '@/lib/finance/money';

/** Rs 1 tolerance — published bank calculators round to the rupee. */
const RUPEE = 100;

describe('calculateEMI — matches published bank calculators', () => {
  // Cases named in the spec, cross-checked against the standard EMI formula.
  it('Rs 10,00,000 @ 8.5% for 240 months -> Rs 8,678', () => {
    const emi = calculateEMI(toPaise(10_00_000), 8.5, 240);
    expect(toRupees(emi)).toBeCloseTo(8678.23, 1);
    expect(Math.abs(emi - toPaise(8678))).toBeLessThan(RUPEE);
  });

  it('Rs 5,00,000 @ 12% for 60 months -> Rs 11,122', () => {
    const emi = calculateEMI(toPaise(5_00_000), 12, 60);
    expect(toRupees(emi)).toBeCloseTo(11122.22, 1);
    expect(Math.abs(emi - toPaise(11122))).toBeLessThan(RUPEE);
  });

  it('Rs 50,00,000 @ 7.25% for 360 months -> Rs 34,109', () => {
    const emi = calculateEMI(toPaise(50_00_000), 7.25, 360);
    expect(toRupees(emi)).toBeCloseTo(34108.81, 1);
    expect(Math.abs(emi - toPaise(34109))).toBeLessThan(RUPEE);
  });

  it('treats a zero rate as a plain division', () => {
    expect(calculateEMI(toPaise(120000), 0, 12)).toBe(toPaise(10000));
  });

  it('rejects a non-positive tenure rather than returning nonsense', () => {
    expect(() => calculateEMI(toPaise(100000), 10, 0)).toThrow();
  });

  it('returns zero for a zero principal', () => {
    expect(calculateEMI(0, 10, 12)).toBe(0);
  });
});

describe('generateAmortization', () => {
  it('closes to exactly zero', () => {
    const schedule = generateAmortization({
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-15',
      emiDay: 5,
    });
    expect(schedule.rows).toHaveLength(240);
    expect(schedule.rows[schedule.rows.length - 1].closingBalance).toBe(0);
  });

  it('closes to zero across a range of rates and tenures', () => {
    for (const [p, rate, n] of [
      [5_00_000, 12, 60],
      [50_00_000, 7.25, 360],
      [3_50_000, 10.49, 84],
      [1_00_000, 24, 24],
      [2_00_000, 0, 10],
    ] as Array<[number, number, number]>) {
      const s = generateAmortization({
        principal: toPaise(p),
        annualRatePercent: rate,
        tenureMonths: n,
        startDate: '2026-04-01',
        emiDay: 10,
      });
      expect(s.rows[s.rows.length - 1].closingBalance).toBe(0);
      expect(s.rows).toHaveLength(n);
    }
  });

  it('keeps principal + interest equal to the total paid', () => {
    const s = generateAmortization({
      principal: toPaise(5_00_000),
      annualRatePercent: 12,
      tenureMonths: 60,
      startDate: '2026-01-01',
      emiDay: 5,
    });
    expect(s.totalPrincipal).toBe(toPaise(5_00_000));
    expect(s.totalPaid).toBe(s.totalPrincipal + s.totalInterest);
  });

  it('every row balances: opening - principal = closing', () => {
    const s = generateAmortization({
      principal: toPaise(8_00_000),
      annualRatePercent: 9.1,
      tenureMonths: 120,
      startDate: '2026-06-20',
      emiDay: 3,
    });
    for (const row of s.rows) {
      expect(row.openingBalance - row.principalComponent - (row.prepayment ?? 0)).toBe(
        row.closingBalance,
      );
      expect(row.interestComponent + row.principalComponent).toBe(row.emi);
    }
  });

  it('clamps the EMI date in short months', () => {
    const s = generateAmortization({
      principal: toPaise(1_00_000),
      annualRatePercent: 10,
      tenureMonths: 14,
      startDate: '2026-01-01',
      emiDay: 31,
    });
    const feb = s.rows.find((r) => r.dueDate.startsWith('2026-02'));
    expect(feb?.dueDate).toBe('2026-02-28');
  });

  it('total interest agrees with the closed-form figure', () => {
    const s = generateAmortization({
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-01',
      emiDay: 5,
    });
    const closedForm = totalInterestOnLoan(toPaise(10_00_000), 8.5, 240);
    // The schedule's last instalment absorbs rounding, so allow a few rupees.
    expect(Math.abs(s.totalInterest - closedForm)).toBeLessThan(toPaise(10));
  });
});

describe('prepayment', () => {
  it('shortens the tenure and saves interest', () => {
    const input = {
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-01',
      emiDay: 5,
    };
    const result = simulatePrepayment(input, {
      afterInstallment: 12,
      amount: toPaise(2_00_000),
      mode: 'REDUCE_TENURE',
    });

    expect(result.monthsSaved).toBeGreaterThan(0);
    expect(result.interestSaved).toBeGreaterThan(0);
    expect(result.withPrepayment.months).toBeLessThan(result.withoutPrepayment.months);
    expect(result.withPrepayment.totalInterest).toBeLessThan(result.withoutPrepayment.totalInterest);
  });

  it('reduce-EMI keeps the tenure but lowers the instalment', () => {
    const input = {
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-01',
      emiDay: 5,
    };
    const baseEmi = calculateEMI(input.principal, input.annualRatePercent, input.tenureMonths);
    const result = simulatePrepayment(input, {
      afterInstallment: 12,
      amount: toPaise(2_00_000),
      mode: 'REDUCE_EMI',
    });
    expect(result.newEmi).toBeLessThan(baseEmi);
    expect(result.interestSaved).toBeGreaterThan(0);
  });

  it('prepaying earlier saves more than prepaying later', () => {
    const input = {
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-01',
      emiDay: 5,
    };
    const early = simulatePrepayment(input, {
      afterInstallment: 6,
      amount: toPaise(2_00_000),
      mode: 'REDUCE_TENURE',
    });
    const late = simulatePrepayment(input, {
      afterInstallment: 120,
      amount: toPaise(2_00_000),
      mode: 'REDUCE_TENURE',
    });
    expect(early.interestSaved).toBeGreaterThan(late.interestSaved);
  });
});

describe('tenureForEMI', () => {
  it('inverts the EMI formula', () => {
    const emi = calculateEMI(toPaise(5_00_000), 12, 60);
    expect(tenureForEMI(toPaise(5_00_000), 12, emi)).toBe(60);
  });

  it('returns null when the EMI cannot even cover the interest', () => {
    // Rs 1L at 45% accrues Rs 3,750/month; a Rs 1,000 EMI never amortises.
    expect(tenureForEMI(toPaise(1_00_000), 45, toPaise(1000))).toBeNull();
  });
});

describe('outstandingAfter', () => {
  it('agrees with the generated schedule', () => {
    const s = generateAmortization({
      principal: toPaise(10_00_000),
      annualRatePercent: 8.5,
      tenureMonths: 240,
      startDate: '2026-01-01',
      emiDay: 5,
    });
    for (const n of [1, 12, 60, 180]) {
      const fromSchedule = s.rows[n - 1].closingBalance;
      const direct = outstandingAfter(toPaise(10_00_000), 8.5, 240, n);
      expect(Math.abs(direct - fromSchedule)).toBeLessThan(RUPEE);
    }
  });

  it('returns the full principal before any instalment is paid', () => {
    expect(outstandingAfter(toPaise(1_00_000), 10, 12, 0)).toBe(toPaise(1_00_000));
  });
});
