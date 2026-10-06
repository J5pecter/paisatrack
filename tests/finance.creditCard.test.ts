import { describe, expect, it } from 'vitest';
import {
  calculateMinimumDue,
  cashAdvanceFeeFor,
  comparePayoffStrategies,
  gstOn,
  interestForDays,
  lateFeeFor,
  overlimitFeeFor,
  runCardLedger,
  simulateMinimumPayments,
  simulatePayoff,
  utilization,
  utilizationBand,
} from '@/lib/finance/creditCard';
import { toPaise, toRupees } from '@/lib/finance/money';

const CARD = {
  statementDay: 18,
  dueDay: 8,
  apr: 45, // 3.75% per month, the standard Indian card rate
  creditLimit: toPaise(1_00_000),
  madPercent: 5,
} as const;

describe('Average Daily Balance formula', () => {
  it("reproduces HDFC's published worked example", () => {
    // Rs 15,000 held for 32 days at 45% p.a.
    // HDFC publishes Rs 591.75; the exact ADB figure is Rs 591.78 - the three
    // paise are rounding in their illustration, not a difference in method.
    const interest = interestForDays(toPaise(15_000), 45, 32);
    expect(toRupees(interest)).toBeCloseTo(591.78, 2);
    expect(Math.abs(toRupees(interest) - 591.75)).toBeLessThan(0.05);
  });

  it('is linear in days and in balance', () => {
    expect(interestForDays(toPaise(10_000), 36, 365)).toBe(toPaise(3_600));
    expect(interestForDays(toPaise(20_000), 36, 365)).toBe(toPaise(7_200));
  });

  it('is zero for a cleared balance', () => {
    expect(interestForDays(0, 45, 30)).toBe(0);
    expect(interestForDays(toPaise(1000), 45, 0)).toBe(0);
  });
});

describe('interest-free period', () => {
  const purchases = [
    { id: 't1', date: '2026-04-05', amount: toPaise(5_000), type: 'RETAIL' as const },
    { id: 't2', date: '2026-04-10', amount: toPaise(15_000), type: 'RETAIL' as const },
  ];

  it('the statement itself never carries interest while grace is still pending', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: purchases,
      payments: [],
      asOf: '2026-04-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.totalAmountDue).toBe(toPaise(20_000));
    expect(april.minimumDue).toBe(toPaise(1_000)); // 5% of 20,000
    expect(april.interestCharged).toBe(0);
  });

  it('paying in full by the due date costs nothing', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: purchases,
      payments: [{ id: 'p1', date: '2026-05-05', amount: toPaise(20_000) }],
      asOf: '2026-05-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;

    expect(april.paidInFull).toBe(true);
    expect(april.status).toBe('PAID');
    expect(may.interestCharged).toBe(0);
    expect(r.revolving).toBe(false);
    expect(r.currentOutstanding).toBe(0);
  });

  it('a partial payment charges interest from each TRANSACTION date, not the statement date', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: purchases,
      payments: [{ id: 'p1', date: '2026-05-12', amount: toPaise(2_000) }],
      asOf: '2026-05-18',
    });
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;

    expect(may.interestCharged).toBeGreaterThan(0);
    expect(r.revolving).toBe(true);

    // The Rs 15,000 purchase on 10-Apr accrues right through to the 18-May
    // statement: 38 days, not the 30 days from the 18-Apr statement date.
    const fromTransactionDate = interestForDays(toPaise(15_000), 45, 38);
    const fromStatementDate = interestForDays(toPaise(15_000), 45, 30);
    expect(fromTransactionDate).toBeGreaterThan(fromStatementDate);

    // Total billed interest must at least cover that single lot's full run.
    expect(may.interestCharged).toBeGreaterThanOrEqual(fromTransactionDate);
    // ...and the whole bill is the three open lots together.
    expect(toRupees(may.interestCharged)).toBeCloseTo(965.34, 1);
  });

  it('missing the minimum triggers the late fee for the slab', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: purchases,
      payments: [],
      asOf: '2026-05-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.minimumPaid).toBe(false);
    expect(april.status).toBe('OVERDUE');
    expect(april.lateFee).toBe(toPaise(1_000)); // Rs 20,000 falls in the Rs 10k-25k slab
  });

  it('paying the minimum avoids the late fee but not the interest', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: purchases,
      payments: [{ id: 'p1', date: '2026-05-05', amount: toPaise(1_000) }],
      asOf: '2026-05-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;

    expect(april.minimumPaid).toBe(true);
    expect(april.lateFee).toBe(0);
    expect(april.status).toBe('MIN_PAID');
    expect(may.interestCharged).toBeGreaterThan(0); // grace still lost
  });
});

describe('cash advances', () => {
  it('accrue from day one even when the statement is paid in full', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [
        { id: 'c1', date: '2026-04-10', amount: toPaise(10_000), type: 'CASH_ADVANCE' },
      ],
      // Pay the full statement, including the cash advance fee, by the due date.
      payments: [{ id: 'p1', date: '2026-05-05', amount: toPaise(11_000) }],
      asOf: '2026-05-18',
    });
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;
    // A retail purchase in the same position would have cost nothing.
    expect(may.interestCharged).toBeGreaterThan(0);
  });

  it('charge 2.5% or Rs 500, whichever is higher', () => {
    expect(cashAdvanceFeeFor(toPaise(10_000))).toBe(toPaise(500)); // 2.5% = 250 -> floor wins
    expect(cashAdvanceFeeFor(toPaise(1_00_000))).toBe(toPaise(2_500));
    expect(cashAdvanceFeeFor(0)).toBe(0);
  });

  it('bill the fee on the statement', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [
        { id: 'c1', date: '2026-04-10', amount: toPaise(1_00_000), type: 'CASH_ADVANCE' },
      ],
      payments: [],
      creditLimit: toPaise(5_00_000),
      asOf: '2026-04-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.cashAdvanceFee).toBe(toPaise(2_500));
  });
});

describe('fee schedules', () => {
  it('applies the published late fee slabs', () => {
    expect(lateFeeFor(toPaise(50))).toBe(0);
    expect(lateFeeFor(toPaise(100))).toBe(toPaise(100));
    expect(lateFeeFor(toPaise(500))).toBe(toPaise(100));
    expect(lateFeeFor(toPaise(501))).toBe(toPaise(500));
    expect(lateFeeFor(toPaise(5_000))).toBe(toPaise(500));
    expect(lateFeeFor(toPaise(5_001))).toBe(toPaise(700));
    expect(lateFeeFor(toPaise(10_000))).toBe(toPaise(700));
    expect(lateFeeFor(toPaise(10_001))).toBe(toPaise(1_000));
    expect(lateFeeFor(toPaise(25_000))).toBe(toPaise(1_000));
    expect(lateFeeFor(toPaise(25_001))).toBe(toPaise(1_300));
    expect(lateFeeFor(toPaise(5_00_000))).toBe(toPaise(1_300));
  });

  it('charges 2.5% over limit with a Rs 500 floor', () => {
    expect(overlimitFeeFor(0)).toBe(0);
    expect(overlimitFeeFor(toPaise(1_000))).toBe(toPaise(500));
    expect(overlimitFeeFor(toPaise(1_00_000))).toBe(toPaise(2_500));
  });

  it('adds 18% GST on interest and fees', () => {
    expect(gstOn(toPaise(1_000))).toBe(toPaise(180));
    expect(gstOn(0)).toBe(0);
  });

  it('charges the overlimit fee when the balance exceeds the limit', () => {
    const r = runCardLedger({
      ...CARD,
      creditLimit: toPaise(10_000),
      transactions: [
        { id: 't1', date: '2026-04-05', amount: toPaise(15_000), type: 'RETAIL' },
      ],
      payments: [],
      asOf: '2026-04-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.overlimitFee).toBeGreaterThan(0);
    expect(april.utilizationPercent).toBeGreaterThan(100);
  });
});

describe('Minimum Amount Due', () => {
  it('is 5% for a standard card', () => {
    expect(calculateMinimumDue({ totalOutstanding: toPaise(20_000), retailSpends: toPaise(20_000) }))
      .toBe(toPaise(1_000));
  });

  it("is 2% on IndusInd's schedule", () => {
    expect(
      calculateMinimumDue({
        totalOutstanding: toPaise(50_000),
        retailSpends: toPaise(50_000),
        madPercent: 2,
      }),
    ).toBe(toPaise(1_000));
  });

  it('adds 100% of EMI, GST, fees, finance charges and overlimit', () => {
    const mad = calculateMinimumDue({
      totalOutstanding: toPaise(50_000),
      emiAmount: toPaise(5_000),
      gst: toPaise(180),
      fees: toPaise(500),
      financeCharges: toPaise(1_000),
      overlimitAmount: 0,
      retailSpends: toPaise(43_320),
      madPercent: 5,
    });
    // Mandatory = 5,000 + 180 + 500 + 1,000 = 6,680.
    // Residual  = 50,000 - 6,680 = 43,320, of which 5% = 2,166.
    expect(mad).toBe(toPaise(6_680 + 2_166));
  });

  it("applies HDFC's 30% variant when it bites", () => {
    const standard = calculateMinimumDue({
      totalOutstanding: toPaise(50_000),
      financeCharges: toPaise(1_000),
      retailSpends: toPaise(40_000),
      gst: toPaise(180),
      fees: 0,
      madPercent: 5,
      variant: 'STANDARD',
    });
    const hdfc = calculateMinimumDue({
      totalOutstanding: toPaise(50_000),
      financeCharges: toPaise(1_000),
      retailSpends: toPaise(40_000),
      gst: toPaise(180),
      fees: 0,
      madPercent: 5,
      variant: 'HDFC',
    });
    // 30% of (1,000 + 40,000) = 12,300, which exceeds the finance charge,
    // so HDFC bills GST + fees + 12,300.
    expect(hdfc).toBe(toPaise(180 + 12_300));
    expect(hdfc).toBeGreaterThan(standard);
  });

  it('never asks for more than you owe', () => {
    expect(calculateMinimumDue({ totalOutstanding: toPaise(300) })).toBe(toPaise(300));
    const mad = calculateMinimumDue({
      totalOutstanding: toPaise(1_000),
      financeCharges: toPaise(900),
      fees: toPaise(500),
    });
    expect(mad).toBeLessThanOrEqual(toPaise(1_000));
  });

  it('applies the Rs 500 floor above it, and the balance below it', () => {
    // 5% of 5,000 = 250, so the floor binds.
    expect(calculateMinimumDue({ totalOutstanding: toPaise(5_000) })).toBe(toPaise(500));
    // Below the floor, you simply owe the balance.
    expect(calculateMinimumDue({ totalOutstanding: toPaise(400) })).toBe(toPaise(400));
  });

  it('is zero when nothing is owed', () => {
    expect(calculateMinimumDue({ totalOutstanding: 0 })).toBe(0);
  });
});

describe('the minimum-due trap', () => {
  it('shows just how long Rs 1L at 45% actually takes', () => {
    const sim = simulateMinimumPayments(toPaise(1_00_000), 45, 5);

    expect(sim.neverPaysOff).toBe(false);
    // The spec's claim: 8+ years in debt.
    expect(sim.years).toBeGreaterThanOrEqual(8);
    // ...and more interest than the original balance.
    expect(sim.totalInterest).toBeGreaterThan(toPaise(1_00_000));
    expect(sim.totalPaid).toBe(sim.totalInterest + toPaise(1_00_000));
    expect(sim.schedule).toHaveLength(sim.months);
    expect(sim.schedule[sim.schedule.length - 1].closingBalance).toBe(0);
  });

  it('every month reduces the balance', () => {
    const sim = simulateMinimumPayments(toPaise(1_00_000), 45, 5);
    for (let i = 1; i < sim.schedule.length; i++) {
      expect(sim.schedule[i].closingBalance).toBeLessThan(sim.schedule[i - 1].closingBalance);
    }
  });

  it('flags the case where the minimum never clears the interest instead of hanging', () => {
    // A 1% minimum against a 60% APR: the payment never covers the interest.
    const sim = simulateMinimumPayments(toPaise(10_00_000), 60, 1, 0);
    expect(sim.neverPaysOff).toBe(true);
  });

  it('returns an empty result for a cleared card', () => {
    expect(simulateMinimumPayments(0, 45, 5).months).toBe(0);
  });
});

describe('payoff planner', () => {
  const cards = [
    { id: 'a', name: 'HDFC Regalia', balance: toPaise(80_000), apr: 43.2 },
    { id: 'b', name: 'SBI SimplyCLICK', balance: toPaise(25_000), apr: 45 },
    { id: 'c', name: 'ICICI Amazon Pay', balance: toPaise(10_000), apr: 40 },
  ];

  it('avalanche never costs more interest than snowball', () => {
    const { avalanche, snowball } = comparePayoffStrategies(cards, toPaise(15_000));
    expect(avalanche.feasible).toBe(true);
    expect(snowball.feasible).toBe(true);
    expect(avalanche.totalInterest).toBeLessThanOrEqual(snowball.totalInterest);
  });

  it('avalanche targets the highest APR first', () => {
    const r = simulatePayoff(cards, toPaise(15_000), 'AVALANCHE');
    // SBI at 45% is the highest rate, so it clears before HDFC at 43.2%.
    const sbi = r.payoffOrder.find((p) => p.cardId === 'b')!;
    const hdfc = r.payoffOrder.find((p) => p.cardId === 'a')!;
    expect(sbi.clearedInMonth).toBeLessThan(hdfc.clearedInMonth);
  });

  it('snowball targets the smallest balance first', () => {
    const r = simulatePayoff(cards, toPaise(15_000), 'SNOWBALL');
    expect(r.payoffOrder[0].cardId).toBe('c'); // Rs 10,000 is the smallest
  });

  it('clears every card and reports the order', () => {
    const r = simulatePayoff(cards, toPaise(15_000), 'AVALANCHE');
    expect(r.payoffOrder).toHaveLength(3);
    expect(r.months).toBeGreaterThan(0);
    expect(r.schedule[r.schedule.length - 1].totalBalance).toBe(0);
  });

  it('says so when the budget cannot even cover the minimums', () => {
    const r = simulatePayoff(cards, toPaise(500), 'AVALANCHE');
    expect(r.feasible).toBe(false);
    expect(r.minimumBudgetRequired).toBeGreaterThan(toPaise(500));
  });

  it('a bigger budget always finishes sooner', () => {
    const small = simulatePayoff(cards, toPaise(8_000), 'AVALANCHE');
    const large = simulatePayoff(cards, toPaise(30_000), 'AVALANCHE');
    expect(large.months).toBeLessThan(small.months);
    expect(large.totalInterest).toBeLessThan(small.totalInterest);
  });

  it('handles an empty card list', () => {
    expect(simulatePayoff([], toPaise(10_000), 'AVALANCHE').months).toBe(0);
  });
});

describe('utilization', () => {
  it('is a percentage of the limit', () => {
    expect(utilization(toPaise(30_000), toPaise(1_00_000))).toBe(30);
    expect(utilization(0, toPaise(1_00_000))).toBe(0);
    expect(utilization(toPaise(10_000), 0)).toBe(0); // no limit set
  });

  it('bands at the CIBIL thresholds', () => {
    expect(utilizationBand(29)).toBe('GOOD');
    expect(utilizationBand(30)).toBe('WATCH');
    expect(utilizationBand(50)).toBe('WATCH');
    expect(utilizationBand(51)).toBe('HIGH');
  });
});

describe('ledger edge cases', () => {
  it('handles a card with no activity at all', () => {
    const r = runCardLedger({ ...CARD, transactions: [], payments: [], asOf: '2026-05-18' });
    expect(r.statements).toHaveLength(0);
    expect(r.currentOutstanding).toBe(0);
    expect(r.nextStatementDate).toBeTruthy();
  });

  it('applies a refund from its posting date', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [
        { id: 't1', date: '2026-04-05', amount: toPaise(10_000), type: 'RETAIL' },
        { id: 'r1', date: '2026-04-10', amount: toPaise(4_000), type: 'REFUND' },
      ],
      payments: [],
      asOf: '2026-04-18',
    });
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.totalAmountDue).toBe(toPaise(6_000));
    expect(april.refunds).toBe(toPaise(4_000));
  });

  it('leaves a credit balance when you overpay', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [{ id: 't1', date: '2026-04-05', amount: toPaise(5_000), type: 'RETAIL' }],
      payments: [{ id: 'p1', date: '2026-04-20', amount: toPaise(8_000) }],
      asOf: '2026-05-18',
    });
    expect(r.currentOutstanding).toBeLessThan(0);
  });

  it('clamps the statement day in February', () => {
    const r = runCardLedger({
      ...CARD,
      statementDay: 31,
      transactions: [{ id: 't1', date: '2026-02-05', amount: toPaise(5_000), type: 'RETAIL' }],
      payments: [],
      asOf: '2026-03-05',
    });
    expect(r.statements.some((s) => s.statementDate === '2026-02-28')).toBe(true);
  });

  it('keeps charging interest month after month while revolving', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [{ id: 't1', date: '2026-01-05', amount: toPaise(50_000), type: 'RETAIL' }],
      payments: [],
      asOf: '2026-06-18',
    });
    const charging = r.statements.filter((s) => s.interestCharged > 0);
    expect(charging.length).toBeGreaterThanOrEqual(3);
    expect(r.currentOutstanding).toBeGreaterThan(toPaise(50_000));
  });
});
