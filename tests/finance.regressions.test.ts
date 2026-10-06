/**
 * Regressions.
 *
 * Every test here corresponds to a defect found by an adversarial audit of the
 * finance engine. They exist so the same mistake cannot come back.
 */
import { describe, expect, it } from 'vitest';
import {
  calculateMinimumDue,
  calculateStatementInterest,
  interestForDays,
  runCardLedger,
} from '@/lib/finance/creditCard';
import { generateAmortization } from '@/lib/finance/emi';
import { compareTaxRegimes, computeTax, ctcToInHand } from '@/lib/finance/salary';
import { toPaise } from '@/lib/finance/money';

const CARD = {
  statementDay: 18,
  dueDay: 8,
  apr: 45,
  creditLimit: toPaise(1_00_000),
  madPercent: 5,
} as const;

describe('a payment landing exactly on the statement date', () => {
  // It already reduces the billed balance, so counting it again as "paid by the
  // due date" would settle a statement it had in fact only shrunk — handing the
  // cardholder a free interest-free period on a balance they still owe.
  const scenario = {
    ...CARD,
    transactions: [
      { id: 't1', date: '2026-04-05', amount: toPaise(20_000), type: 'RETAIL' as const },
      { id: 't2', date: '2026-04-10', amount: toPaise(10_000), type: 'RETAIL' as const },
    ],
    payments: [{ id: 'p1', date: '2026-04-18', amount: toPaise(15_000) }],
    asOf: '2026-06-18',
  };

  it('is not counted twice', () => {
    const r = runCardLedger(scenario);
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;

    // Rs 30,000 spent, Rs 15,000 paid: the statement bills the net Rs 15,000...
    expect(april.totalAmountDue).toBe(toPaise(15_000));
    // ...and nothing counts towards settling it.
    expect(april.paidByDueDate).toBe(0);
    expect(april.paidInFull).toBe(false);
    expect(april.status).toBe('OVERDUE');
  });

  it('still loses the interest-free period', () => {
    const r = runCardLedger(scenario);
    expect(r.revolving).toBe(true);
    // Interest must appear on the very next statement, not two cycles later.
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;
    expect(may.interestCharged).toBeGreaterThan(0);
  });

  it('charges the late fee that a missed minimum earns', () => {
    const r = runCardLedger(scenario);
    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.lateFee).toBe(toPaise(1_000)); // Rs 15,000 is in the Rs 10k-25k slab
  });
});

describe('calculateStatementInterest with carried transactions', () => {
  const input = {
    previousStatementDate: '2026-04-18',
    statementDate: '2026-05-18',
    dueDate: '2026-06-08',
    apr: 45,
    creditLimit: toPaise(1_00_000),
    carriedTransactions: [
      { id: 'c1', date: '2026-04-10', amount: toPaise(15_000), type: 'RETAIL' as const },
    ],
    transactions: [
      { id: 't1', date: '2026-05-02', amount: toPaise(5_000), type: 'RETAIL' as const },
    ],
    payments: [{ id: 'p1', date: '2026-05-05', amount: toPaise(2_000) }],
    previousPaidInFull: false,
  };

  it('does not silently drop a transaction dated before the previous statement', () => {
    const r = calculateStatementInterest(input);
    // Rs 15,000 carried + Rs 5,000 new - Rs 2,000 paid = Rs 18,000, plus charges.
    expect(r.totalAmountDue).toBeGreaterThanOrEqual(toPaise(18_000));
  });

  it('charges the carried purchase from its own transaction date', () => {
    const withCarried = calculateStatementInterest(input);
    const withoutCarried = calculateStatementInterest({ ...input, carriedTransactions: [] });

    // The carried purchase must show up in both the balance and the interest.
    expect(withCarried.totalAmountDue - withoutCarried.totalAmountDue)
      .toBeGreaterThanOrEqual(toPaise(13_000)); // Rs 15,000 less the Rs 2,000 paid
    expect(withCarried.interest).toBeGreaterThan(withoutCarried.interest);

    // And the interest must reflect the full run from 10-Apr, not from the
    // 18-Apr statement date. The lot sits at Rs 15,000 until the 5-May payment
    // and at Rs 13,000 after it.
    const fromTransactionDate =
      interestForDays(toPaise(15_000), 45, 25) + interestForDays(toPaise(13_000), 45, 13);
    const fromStatementDateOnly = interestForDays(toPaise(15_000), 45, 30);
    expect(withCarried.interest).toBeGreaterThanOrEqual(fromTransactionDate);
    expect(fromTransactionDate).toBeGreaterThan(fromStatementDateOnly);
  });

  it('honours previousPaidInFull instead of re-deriving it', () => {
    const revolving = calculateStatementInterest({ ...input, previousPaidInFull: false });
    const settled = calculateStatementInterest({ ...input, previousPaidInFull: true });
    // Having cleared the previous cycle, this cycle's new spend keeps its grace,
    // so it cannot be charged more than the revolving case.
    expect(settled.interest).toBeLessThanOrEqual(revolving.interest);
    expect(revolving.revolving).toBe(true);
  });
});

describe('late fees', () => {
  it('attract GST and count as mandatory in the minimum due', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [{ id: 't1', date: '2026-04-05', amount: toPaise(20_000), type: 'RETAIL' }],
      payments: [],
      asOf: '2026-05-18',
    });

    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    const may = r.statements.find((s) => s.statementDate === '2026-05-18')!;

    expect(april.lateFee).toBe(toPaise(1_000));
    // GST on the May statement must cover interest *and* the carried late fee.
    const gstOnInterestAlone = Math.round(may.interestCharged * 0.18);
    expect(may.gst).toBeGreaterThan(gstOnInterestAlone);
    // 18% of the Rs 1,000 late fee is Rs 180.
    expect(may.gst).toBeGreaterThanOrEqual(gstOnInterestAlone + toPaise(180) - 2);
  });
});

describe('overpayment', () => {
  it('is spent by the next purchase rather than stranded', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [
        { id: 't1', date: '2026-04-05', amount: toPaise(5_000), type: 'RETAIL' },
        // Posted after the card is already Rs 3,000 in credit.
        { id: 't2', date: '2026-05-02', amount: toPaise(4_000), type: 'RETAIL' },
      ],
      payments: [{ id: 'p1', date: '2026-04-20', amount: toPaise(8_000) }],
      asOf: '2026-05-18',
    });

    // Rs 9,000 spent, Rs 8,000 paid -> Rs 1,000 owed, not Rs 4,000.
    expect(r.currentOutstanding).toBe(toPaise(1_000));
  });

  it('nets off the reported outstanding', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [{ id: 't1', date: '2026-04-05', amount: toPaise(5_000), type: 'RETAIL' }],
      payments: [{ id: 'p1', date: '2026-04-20', amount: toPaise(8_000) }],
      asOf: '2026-05-18',
    });
    expect(r.currentOutstanding).toBe(toPaise(-3_000));
  });
});

describe('a refund that clears the statement', () => {
  it('settles it, the same as a payment would', () => {
    const r = runCardLedger({
      ...CARD,
      transactions: [
        { id: 't1', date: '2026-04-05', amount: toPaise(10_000), type: 'RETAIL' },
        // Merchant reverses the whole purchase before the due date.
        { id: 'r1', date: '2026-04-25', amount: toPaise(10_000), type: 'REFUND' },
      ],
      payments: [],
      asOf: '2026-05-18',
    });

    const april = r.statements.find((s) => s.statementDate === '2026-04-18')!;
    expect(april.paidInFull).toBe(true);
    expect(april.lateFee).toBe(0);
    expect(r.revolving).toBe(false);
    expect(r.currentOutstanding).toBe(0);
  });
});

describe("HDFC's alternate minimum-due formula", () => {
  it('is a floor, never a substitute that drops mandatory components', () => {
    const args = {
      totalOutstanding: toPaise(2_00_000),
      emiAmount: toPaise(40_000),
      overlimitAmount: toPaise(10_000),
      financeCharges: toPaise(1_000),
      retailSpends: toPaise(20_000),
      gst: toPaise(180),
      fees: toPaise(500),
      madPercent: 5,
    };
    const standard = calculateMinimumDue({ ...args, variant: 'STANDARD' });
    const hdfc = calculateMinimumDue({ ...args, variant: 'HDFC' });

    // The HDFC branch must never ask for less than the standard formula — doing
    // so would silently waive 100% of the EMI and the overlimit amount.
    expect(hdfc).toBeGreaterThanOrEqual(standard);
    expect(hdfc).toBeGreaterThanOrEqual(args.emiAmount + args.overlimitAmount);
  });

  it('still bites when its 30% term is the larger one', () => {
    const hdfc = calculateMinimumDue({
      totalOutstanding: toPaise(50_000),
      financeCharges: toPaise(1_000),
      retailSpends: toPaise(40_000),
      gst: toPaise(180),
      madPercent: 5,
      variant: 'HDFC',
    });
    expect(hdfc).toBe(toPaise(180 + 12_300));
  });
});

describe('87A marginal relief', () => {
  it('applies under the new regime', () => {
    // Taxable Rs 12,05,000: slab tax Rs 60,750, but only Rs 5,000 over the limit.
    expect(computeTax(toPaise(12_80_000), 'NEW').totalTax).toBe(toPaise(5_200));
  });

  it('does NOT apply under the old regime, where 87A is a hard cliff', () => {
    // Taxable Rs 5,01,000. The old regime has no marginal-relief proviso, so the
    // full slab tax of Rs 12,700 + 4% cess is payable the moment you cross Rs 5L.
    const t = computeTax(toPaise(5_51_000), 'OLD');
    expect(t.taxableIncome).toBe(toPaise(5_01_000));
    expect(t.rebate).toBe(0);
    expect(t.totalTax).toBe(toPaise(13_208)); // 12,700 + 508 cess
  });
});

describe('surcharge marginal relief', () => {
  it('stops tax jumping by more than the income that triggered it', () => {
    const justUnder = computeTax(toPaise(50_74_000), 'NEW'); // taxable 49,99,000
    const justOver = computeTax(toPaise(50_76_000), 'NEW');  // taxable 50,01,000

    expect(justUnder.surcharge).toBe(0);
    const extraIncome = justOver.taxableIncome - justUnder.taxableIncome;
    const extraTax = justOver.totalTax - justUnder.totalTax;

    // Without relief, crossing Rs 50L by Rs 2,000 would cost well over a lakh.
    expect(extraTax).toBeLessThanOrEqual(extraIncome);
  });

  it('still charges full surcharge once well past the threshold', () => {
    expect(computeTax(toPaise(60_00_000), 'NEW').surcharge).toBeGreaterThan(0);
  });
});

describe('CTC breakdown', () => {
  it('always sums back to gross', () => {
    for (const [ctc, basicPct, hraPct] of [
      [12_00_000, 45, 50],
      [50_00_000, 50, 50],
      [3_00_000, 60, 40],
      // Deliberately impossible: basic + HRA cannot fit inside gross.
      [10_00_000, 90, 100],
    ] as Array<[number, number, number]>) {
      const b = ctcToInHand({
        ctcAnnual: toPaise(ctc),
        basicPercent: basicPct,
        hraPercent: hraPct,
      });
      expect(b.basicAnnual + b.hraAnnual + b.specialAllowanceAnnual).toBe(b.grossAnnual);
    }
  });

  it('flags a salary structure that cannot fit inside gross', () => {
    const impossible = ctcToInHand({ ctcAnnual: toPaise(10_00_000), basicPercent: 90, hraPercent: 100 });
    expect(impossible.componentsExceedGross).toBe(true);

    const normal = ctcToInHand({ ctcAnnual: toPaise(12_00_000) });
    expect(normal.componentsExceedGross).toBe(false);
  });

  it('has a monthly column that adds up to the monthly gross', () => {
    for (const ctc of [12_00_000, 18_50_000, 7_77_777]) {
      const m = ctcToInHand({ ctcAnnual: toPaise(ctc) }).monthly;
      expect(m.basic + m.hra + m.specialAllowance).toBe(m.gross);
    }
  });
});

describe('section 80D', () => {
  it('is capped at the statutory Rs 1,00,000', () => {
    const t = computeTax(toPaise(20_00_000), 'OLD', { section80D: toPaise(5_00_000) });
    expect(t.otherDeductions).toBe(toPaise(1_00_000));
  });

  it('passes through below the cap', () => {
    const t = computeTax(toPaise(20_00_000), 'OLD', { section80D: toPaise(25_000) });
    expect(t.otherDeductions).toBe(toPaise(25_000));
  });
});

describe('amortization start date', () => {
  it('is timezone-independent', () => {
    // `new Date('2026-04-15')` parses as UTC midnight; west of UTC that lands on
    // the 14th locally and would push the first EMI out by a whole month.
    const s = generateAmortization({
      principal: toPaise(1_00_000),
      annualRatePercent: 9,
      tenureMonths: 6,
      startDate: '2026-04-15',
      emiDay: 15,
    });
    // Start date IS the EMI day, so the first instalment belongs to the next month.
    expect(s.rows[0].dueDate).toBe('2026-05-15');
    expect(s.rows).toHaveLength(6);
  });

  it('keeps the first EMI in the same month when the day is still ahead', () => {
    const s = generateAmortization({
      principal: toPaise(1_00_000),
      annualRatePercent: 9,
      tenureMonths: 6,
      startDate: '2026-04-01',
      emiDay: 15,
    });
    expect(s.rows[0].dueDate).toBe('2026-04-15');
  });
});

describe('regime comparison after the fixes', () => {
  it('still recommends the old regime where deductions genuinely win', () => {
    const c = compareTaxRegimes(toPaise(14_00_000), {
      section80C: toPaise(1_50_000),
      section80CCD1B: toPaise(50_000),
      section80D: toPaise(25_000),
      hraExemption: toPaise(2_40_000),
      homeLoanInterest: toPaise(2_00_000),
    });
    expect(c.recommended).toBe('OLD');
  });
});
