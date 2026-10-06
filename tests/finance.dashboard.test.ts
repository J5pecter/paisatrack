/**
 * Dashboard aggregates.
 *
 * These are the numbers the user actually reads, so the tests check that the
 * figures agree with each other as much as that each one is individually right
 * — a dashboard whose tiles contradict one another is worse than useless.
 */
import { describe, expect, it } from 'vitest';
import {
  budgetProgress,
  cardHealth,
  debtOverview,
  goalProgress,
  monthSnapshot,
  monthlyTrend,
  netWorth,
  safeToSpend,
  spendByCategory,
  topMerchants,
  upcomingDues,
} from '@/lib/finance/dashboard';
import { sumMoney, toPaise } from '@/lib/finance/money';
import type {
  Bill,
  BillEntry,
  Budget,
  CreditCard,
  CreditCardStatement,
  Expense,
  Goal,
  Income,
  Investment,
  Loan,
} from '@/types';

const STAMP = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const NOW = new Date('2026-06-10T00:00:00');
const MONTH = '2026-06';

const income: Income[] = [
  { id: 'i1', userId: 'u', source: 'Salary', type: 'SALARY', amount: toPaise(80_000), frequency: 'MONTHLY', creditedOn: 1, effectiveFrom: '2025-01-01', isActive: true, ...STAMP },
  { id: 'i2', userId: 'u', source: 'FD', type: 'INTEREST', amount: toPaise(9_000), frequency: 'QUARTERLY', effectiveFrom: '2025-01-01', isActive: true, ...STAMP },
  { id: 'i3', userId: 'u', source: 'Old job', type: 'SALARY', amount: toPaise(50_000), frequency: 'MONTHLY', effectiveFrom: '2024-01-01', isActive: false, ...STAMP },
];

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'e1', userId: 'u', amount: toPaise(500), category: 'FOOD', description: 'Swiggy',
    date: '2026-06-05', paymentMethod: 'UPI', creditCardId: null, isRecurring: false, ...STAMP, ...over,
  };
}

const expenses: Expense[] = [
  expense({ id: 'e1', amount: toPaise(1_200), category: 'FOOD', description: 'Swiggy order' }),
  expense({ id: 'e2', amount: toPaise(800), category: 'FOOD', description: 'Swiggy order' }),
  expense({ id: 'e3', amount: toPaise(3_000), category: 'GROCERIES', description: 'BigBasket', paymentMethod: 'CREDIT_CARD', creditCardId: 'c1' }),
  expense({ id: 'e4', amount: toPaise(600), category: 'TRANSPORT', description: 'Uber' }),
  // Last month — must not leak into June's figures.
  expense({ id: 'e5', amount: toPaise(9_999), category: 'SHOPPING', date: '2026-05-20' }),
];

const loans: Loan[] = [
  { id: 'l1', userId: 'u', loanName: 'Personal', lender: 'IDFC', type: 'PERSONAL', principalAmount: toPaise(3_50_000), interestRate: 10.49, tenureMonths: 48, emiAmount: toPaise(8_959), startDate: '2025-04-05', emiDay: 5, outstandingPrincipal: toPaise(2_62_400), isActive: true, ...STAMP },
  { id: 'l2', userId: 'u', loanName: 'Closed', lender: 'SBI', type: 'CAR', principalAmount: toPaise(5_00_000), interestRate: 9, tenureMonths: 60, emiAmount: toPaise(10_000), startDate: '2020-01-05', emiDay: 5, outstandingPrincipal: 0, isActive: false, ...STAMP },
];

const cards: CreditCard[] = [
  { id: 'c1', userId: 'u', cardName: 'SimplyCLICK', issuer: 'SBI Card', last4: '9033', creditLimit: toPaise(1_00_000), statementDay: 5, dueDay: 25, apr: 45, madPercent: 5, madVariant: 'STANDARD', isActive: true, ...STAMP },
  { id: 'c2', userId: 'u', cardName: 'Millennia', issuer: 'HDFC Bank', last4: '4821', creditLimit: toPaise(2_00_000), statementDay: 18, dueDay: 8, apr: 43.2, madPercent: 5, madVariant: 'HDFC', isActive: true, ...STAMP },
];

const statements: CreditCardStatement[] = [
  { id: 's1', cardId: 'c1', statementMonth: '2026-06', statementDate: '2026-06-05', dueDate: '2026-06-25', previousStatementDate: '2026-05-05', openingBalance: toPaise(30_000), totalAmountDue: toPaise(40_000), minimumDue: toPaise(2_000), transactions: [], payments: [], totalPaid: toPaise(2_000), minimumPaid: true, interestCharged: toPaise(1_400), lateFee: 0, overlimitFee: 0, cashAdvanceFee: 0, gst: toPaise(252), status: 'MIN_PAID', revolving: true, ...STAMP },
  { id: 's0', cardId: 'c1', statementMonth: '2026-05', statementDate: '2026-05-05', dueDate: '2026-05-25', previousStatementDate: '2026-04-05', openingBalance: 0, totalAmountDue: toPaise(30_000), minimumDue: toPaise(1_500), transactions: [], payments: [], totalPaid: toPaise(30_000), minimumPaid: true, interestCharged: 0, lateFee: 0, overlimitFee: 0, cashAdvanceFee: 0, gst: 0, status: 'PAID', revolving: false, ...STAMP },
];

const bills: Bill[] = [
  { id: 'b1', userId: 'u', name: 'Rent', category: 'RENT', type: 'FIXED', defaultAmount: toPaise(18_000), frequency: 'MONTHLY', dueDay: 5, isAutopay: false, isActive: true, ...STAMP },
  { id: 'b2', userId: 'u', name: 'Internet', category: 'INTERNET', type: 'FIXED', defaultAmount: toPaise(999), frequency: 'MONTHLY', dueDay: 20, isAutopay: true, isActive: true, ...STAMP },
];

const billEntries: BillEntry[] = [
  { id: 'be1', billId: 'b1', billingMonth: MONTH, amount: toPaise(18_000), dueDate: '2026-06-05', paidOn: '2026-06-05', status: 'PAID', ...STAMP },
  { id: 'be2', billId: 'b2', billingMonth: MONTH, amount: toPaise(999), dueDate: '2026-06-20', paidOn: null, status: 'PENDING', ...STAMP },
];

describe('month snapshot', () => {
  const snap = monthSnapshot({ month: MONTH, income, expenses, billEntries, loans, asOf: NOW });

  it('counts only active income, normalised to a month', () => {
    // 80,000 monthly + 9,000 quarterly / 3 = 83,000. The inactive job is excluded.
    expect(snap.incomeExpected).toBe(toPaise(83_000));
  });

  it('treats income as received once its credit day has passed', () => {
    // Salary lands on the 1st; by the 10th it has arrived. The FD is quarterly,
    // so it does not count towards "received this month".
    expect(snap.incomeReceived).toBe(toPaise(80_000));
  });

  it('counts only this month expenses', () => {
    expect(snap.expensesTotal).toBe(toPaise(5_600)); // the May 9,999 is excluded
  });

  it('separates card spend out of the expense total', () => {
    expect(snap.cardPayments).toBe(toPaise(3_000));
  });

  it('sums bills and EMIs for the month', () => {
    expect(snap.billsTotal).toBe(toPaise(18_999));
    expect(snap.emiTotal).toBe(toPaise(8_959)); // only the active loan
  });

  it('derives savings and the rate consistently', () => {
    const committed = snap.expensesTotal + snap.billsTotal + snap.emiTotal;
    expect(snap.savings).toBe(snap.incomeExpected - committed);
    expect(snap.savingsRatePercent).toBeCloseTo((snap.savings / snap.incomeExpected) * 100, 1);
  });

  it('never reports negative savings', () => {
    const broke = monthSnapshot({
      month: MONTH,
      income: [{ ...income[0], amount: toPaise(1_000) }],
      expenses, billEntries, loans, asOf: NOW,
    });
    expect(broke.savings).toBe(0);
    expect(broke.incomeRemainingPercent).toBe(0);
  });

  it('handles having no income at all without dividing by zero', () => {
    const none = monthSnapshot({ month: MONTH, income: [], expenses, billEntries, loans, asOf: NOW });
    expect(none.savingsRatePercent).toBe(0);
    expect(none.incomeRemainingPercent).toBe(0);
  });

  it('reports days left and a per-day figure', () => {
    expect(snap.daysLeft).toBe(21); // 10 June -> 30 June inclusive
    expect(snap.safeToSpendPerDay).toBe(Math.round(snap.savings / 21));
  });
});

describe('upcoming dues', () => {
  const dues = upcomingDues({ cards, statements, loans, bills, billEntries, days: 30, asOf: NOW });

  it('merges cards, EMIs and bills into one list', () => {
    expect(dues.some((d) => d.kind === 'CARD')).toBe(true);
    expect(dues.some((d) => d.kind === 'EMI')).toBe(true);
    expect(dues.some((d) => d.kind === 'BILL')).toBe(true);
  });

  it('sorts soonest first', () => {
    for (let i = 1; i < dues.length; i++) {
      expect(dues[i].daysUntil).toBeGreaterThanOrEqual(dues[i - 1].daysUntil);
    }
  });

  it('shows the unpaid balance on a card, not the full statement', () => {
    const card = dues.find((d) => d.relatedId === 'c1')!;
    expect(card.amount).toBe(toPaise(38_000)); // 40,000 due less 2,000 paid
  });

  it('shows a card with no statement logged, flagged as such', () => {
    const hdfc = dues.find((d) => d.relatedId === 'c2')!;
    expect(hdfc.amount).toBe(0);
    expect(hdfc.sublabel).toContain('not logged');
  });

  it('excludes paid bills', () => {
    expect(dues.some((d) => d.id === 'bill-be1')).toBe(false); // rent is paid
    expect(dues.some((d) => d.id === 'bill-be2')).toBe(true);
  });

  it('respects the horizon', () => {
    const short = upcomingDues({ cards, statements, loans, bills, billEntries, days: 3, asOf: NOW });
    expect(short.every((d) => d.daysUntil <= 3)).toBe(true);
    expect(short.length).toBeLessThan(dues.length);
  });

  it('marks overdue items', () => {
    const late = upcomingDues({
      cards: [], statements: [], loans: [], bills,
      billEntries: [{ ...billEntries[1], dueDate: '2026-06-01', status: 'OVERDUE' }],
      asOf: NOW,
    });
    expect(late[0].isOverdue).toBe(true);
    expect(late[0].daysUntil).toBeLessThan(0);
  });
});

describe('debt overview', () => {
  const debt = debtOverview({ cards, statements, loans });

  it('sums card and loan balances', () => {
    expect(debt.cardOutstanding).toBe(toPaise(38_000));
    expect(debt.loanOutstanding).toBe(toPaise(2_62_400)); // active loan only
    expect(debt.totalDebt).toBe(debt.cardOutstanding + debt.loanOutstanding);
  });

  it('combines EMIs and card minimums into the monthly obligation', () => {
    expect(debt.monthlyObligation).toBe(toPaise(8_959 + 2_000));
  });

  it('reports how much principal has been repaid', () => {
    // Borrowed 3,50,000, still owe 2,62,400 -> 25% repaid.
    expect(debt.repaidPercent).toBeCloseTo(25, 0);
  });

  it('handles having no debt at all', () => {
    const clean = debtOverview({ cards: [], statements: [], loans: [] });
    expect(clean.totalDebt).toBe(0);
    expect(clean.repaidPercent).toBe(0);
  });
});

describe('card health', () => {
  const health = cardHealth({ cards, statements, asOf: NOW });

  it('reports utilization against the limit', () => {
    const sbi = health.find((h) => h.card.id === 'c1')!;
    expect(sbi.outstanding).toBe(toPaise(38_000));
    expect(sbi.utilizationPercent).toBe(38);
  });

  it('sorts the most stretched card first', () => {
    expect(health[0].card.id).toBe('c1');
  });

  it('projects a due date for a card with no statement', () => {
    const hdfc = health.find((h) => h.card.id === 'c2')!;
    expect(hdfc.outstanding).toBe(0);
    expect(hdfc.dueDate).toBeTruthy();
  });
});

describe('spending analysis', () => {
  it('groups by category, largest first, with shares summing to 100', () => {
    const rows = spendByCategory(expenses, MONTH);
    expect(rows[0].category).toBe('GROCERIES');
    expect(rows[0].amount).toBe(toPaise(3_000));
    expect(sumMoney(rows.map((r) => r.amount))).toBe(toPaise(5_600));
    expect(rows.reduce((s, r) => s + r.percent, 0)).toBeCloseTo(100, 0);
  });

  it('counts transactions per category', () => {
    const food = spendByCategory(expenses, MONTH).find((r) => r.category === 'FOOD')!;
    expect(food.count).toBe(2);
  });

  it('rolls repeated descriptions together', () => {
    const top = topMerchants(expenses, MONTH);
    const swiggy = top.find((m) => m.description === 'Swiggy order')!;
    expect(swiggy.count).toBe(2);
    expect(swiggy.amount).toBe(toPaise(2_000));
    expect(top[0].description).toBe('BigBasket'); // largest first
  });

  it('returns nothing for a month with no spend', () => {
    expect(spendByCategory(expenses, '2026-01')).toEqual([]);
  });
});

describe('monthly trend', () => {
  const trend = monthlyTrend({ months: 6, income, expenses, billEntries, loans, asOf: NOW });

  it('returns one point per month, oldest first', () => {
    expect(trend).toHaveLength(6);
    expect(trend[5].month).toBe(MONTH);
    expect(trend[0].month < trend[5].month).toBe(true);
  });

  it('carries this month expenses into the right bucket', () => {
    expect(trend[5].expenses).toBe(toPaise(5_600));
    expect(trend[4].expenses).toBe(toPaise(9_999)); // May
  });

  it('never reports negative savings', () => {
    expect(trend.every((t) => t.savings >= 0)).toBe(true);
  });
});

describe('budgets', () => {
  const budgets: Budget[] = [
    { id: 'bu1', userId: 'u', month: MONTH, category: 'FOOD', limitAmount: toPaise(5_000), rollover: false, ...STAMP },
    { id: 'bu2', userId: 'u', month: MONTH, category: 'GROCERIES', limitAmount: toPaise(2_000), rollover: false, ...STAMP },
    { id: 'bu3', userId: 'u', month: '2026-05', category: 'FOOD', limitAmount: toPaise(9_000), rollover: false, ...STAMP },
  ];

  it('matches spend to the right budget and month', () => {
    const rows = budgetProgress(budgets, expenses, MONTH);
    expect(rows).toHaveLength(2); // May's budget is excluded
    const food = rows.find((r) => r.budget.category === 'FOOD')!;
    expect(food.spent).toBe(toPaise(2_000));
    expect(food.remaining).toBe(toPaise(3_000));
    expect(food.isOver).toBe(false);
  });

  it('flags an over-budget category', () => {
    const groceries = budgetProgress(budgets, expenses, MONTH)
      .find((r) => r.budget.category === 'GROCERIES')!;
    expect(groceries.isOver).toBe(true);
    expect(groceries.remaining).toBe(toPaise(-1_000));
    expect(groceries.percentUsed).toBe(150);
  });

  it('sorts the most-used budget first', () => {
    expect(budgetProgress(budgets, expenses, MONTH)[0].budget.category).toBe('GROCERIES');
  });

  it('computes safe-to-spend from what is left, ignoring overspends', () => {
    const safe = safeToSpend(budgets, expenses, MONTH, NOW);
    // Only FOOD has headroom (3,000). GROCERIES is over and contributes nothing.
    expect(safe.remaining).toBe(toPaise(3_000));
    expect(safe.daysLeft).toBe(21);
    expect(safe.perDay).toBe(Math.round(toPaise(3_000) / 21));
  });
});

describe('net worth', () => {
  const investments: Investment[] = [
    { id: 'v1', userId: 'u', name: 'SIP', type: 'SIP', investedAmount: toPaise(2_00_000), currentValue: toPaise(2_40_000), startDate: '2024-01-01', monthlyContribution: toPaise(10_000), ...STAMP },
    { id: 'v2', userId: 'u', name: 'PPF', type: 'PPF', investedAmount: toPaise(1_00_000), currentValue: toPaise(1_10_000), startDate: '2023-01-01', monthlyContribution: toPaise(5_000), ...STAMP },
  ];

  it('is assets minus debts', () => {
    const w = netWorth({ investments, cards, statements, loans });
    expect(w.investments).toBe(toPaise(3_50_000));
    expect(w.netWorth).toBe(toPaise(3_50_000) - w.cardDebt - w.loanDebt);
  });

  it('reports gains against the invested principal', () => {
    const w = netWorth({ investments, cards: [], statements: [], loans: [] });
    expect(w.gains).toBe(toPaise(50_000));
    expect(w.gainPercent).toBeCloseTo(16.67, 1);
  });

  it('can be negative when debt exceeds assets', () => {
    const w = netWorth({ investments: [], cards, statements, loans });
    expect(w.netWorth).toBeLessThan(0);
  });
});

describe('goals', () => {
  const goals: Goal[] = [
    { id: 'g1', userId: 'u', name: 'Emergency fund', targetAmount: toPaise(5_00_000), currentAmount: toPaise(2_00_000), targetDate: '2026-12-01', type: 'EMERGENCY_FUND', ...STAMP },
    { id: 'g2', userId: 'u', name: 'Done', targetAmount: toPaise(1_00_000), currentAmount: toPaise(1_00_000), targetDate: '2026-12-01', type: 'PURCHASE', ...STAMP },
    { id: 'g3', userId: 'u', name: 'Past due', targetAmount: toPaise(1_00_000), currentAmount: toPaise(10_000), targetDate: '2026-01-01', type: 'TRAVEL', ...STAMP },
  ];
  const rows = goalProgress(goals, NOW);

  it('works out what to put aside each month', () => {
    // 3,00,000 left over 6 months (June -> December).
    expect(rows[0].monthsLeft).toBe(6);
    expect(rows[0].monthlyNeeded).toBe(toPaise(50_000));
    expect(rows[0].percentComplete).toBe(40);
  });

  it('reports a reached goal as complete with nothing left to save', () => {
    expect(rows[1].remaining).toBe(0);
    expect(rows[1].percentComplete).toBe(100);
    expect(rows[1].onTrack).toBe(true);
  });

  it('flags a goal whose date has passed', () => {
    expect(rows[2].monthsLeft).toBe(0);
    expect(rows[2].onTrack).toBe(false);
    // With no months left, the whole remainder is needed now.
    expect(rows[2].monthlyNeeded).toBe(toPaise(90_000));
  });
});
