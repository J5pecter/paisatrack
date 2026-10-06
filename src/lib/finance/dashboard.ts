/**
 * Everything the dashboard shows, derived from the raw records.
 *
 * Pure functions over plain arrays: no database, no React. That keeps the
 * numbers testable and means the whole dashboard recomputes in microseconds
 * from data already in memory.
 */
import { totalLiquid } from './cash';
import type {
  Bill,
  BillEntry,
  Budget,
  CashAccount,
  CreditCard,
  CreditCardStatement,
  Expense,
  ExpenseCategory,
  Goal,
  Income,
  Investment,
  ISODate,
  Loan,
  MonthKey,
  Paise,
} from '@/types';
import {
  dayOfMonthClamped,
  daysLeftInMonth,
  daysUntilDue,
  dueDateFor,
  lastNMonths,
  monthKey,
  nextStatementDate,
  toDate,
  toISODate,
} from './dates';
import { clampZero, formatCompactINR, percentage, sumMoney } from './money';
import { monthlyEquivalent } from './salary';
import { utilization } from './creditCard';
import type { CardState } from './cardState';
import type { LoanState } from './loanState';

// ---------------------------------------------------------------------------
// This month
// ---------------------------------------------------------------------------

export interface MonthSnapshot {
  month: MonthKey;
  incomeReceived: Paise;
  incomeExpected: Paise;
  expensesTotal: Paise;
  billsTotal: Paise;
  emiTotal: Paise;
  cardPayments: Paise;
  /** Income expected minus everything committed. */
  savings: Paise;
  savingsRatePercent: number;
  /** Fraction of the month's income still unspent, 0-100. */
  incomeRemainingPercent: number;
  daysLeft: number;
  /** Remaining budget divided by days left. */
  safeToSpendPerDay: Paise;
}

export function monthSnapshot(params: {
  month: MonthKey;
  income: Income[];
  expenses: Expense[];
  billEntries: BillEntry[];
  loans: Loan[];
  asOf?: Date;
}): MonthSnapshot {
  const { month, income, expenses, billEntries, loans } = params;
  const asOf = params.asOf ?? new Date();

  const incomeExpected = sumMoney(
    income.filter((i) => i.isActive).map((i) => monthlyEquivalent(i.amount, i.frequency)),
  );

  // Treat income as received once its credit day has passed.
  const incomeReceived = sumMoney(
    income
      .filter((i) => i.isActive && i.frequency === 'MONTHLY')
      .filter((i) => (i.creditedOn ?? 1) <= asOf.getDate())
      .map((i) => i.amount),
  );

  const monthExpenses = expenses.filter((e) => e.date.startsWith(month));
  const expensesTotal = sumMoney(monthExpenses.map((e) => e.amount));
  const cardPayments = sumMoney(
    monthExpenses.filter((e) => e.paymentMethod === 'CREDIT_CARD').map((e) => e.amount),
  );

  const billsTotal = sumMoney(
    billEntries.filter((b) => b.billingMonth === month && b.status !== 'SKIPPED').map((b) => b.amount),
  );

  const emiTotal = sumMoney(loans.filter((l) => l.isActive).map((l) => l.emiAmount));

  // Expenses already include anything also logged as a bill payment, so bills
  // are counted once here and expenses are the discretionary layer on top.
  const committed = expensesTotal + billsTotal + emiTotal;
  const savings = clampZero(incomeExpected - committed);

  return {
    month,
    incomeReceived,
    incomeExpected,
    expensesTotal,
    billsTotal,
    emiTotal,
    cardPayments,
    savings,
    savingsRatePercent: incomeExpected > 0 ? percentage(savings, incomeExpected) : 0,
    incomeRemainingPercent:
      incomeExpected > 0 ? Math.max(0, 100 - percentage(committed, incomeExpected)) : 0,
    daysLeft: daysLeftInMonth(asOf),
    safeToSpendPerDay:
      daysLeftInMonth(asOf) > 0 ? Math.round(savings / daysLeftInMonth(asOf)) : 0,
  };
}

// ---------------------------------------------------------------------------
// Upcoming dues
// ---------------------------------------------------------------------------

export type DueKind = 'CARD' | 'EMI' | 'BILL';

export interface UpcomingDue {
  id: string;
  kind: DueKind;
  label: string;
  sublabel?: string;
  amount: Paise;
  dueDate: ISODate;
  daysUntil: number;
  isOverdue: boolean;
  relatedId: string;
}

/**
 * Every payment falling due in the next `days` days, soonest first — card
 * minimums, loan EMIs and bills, in one list.
 */
export function upcomingDues(params: {
  cards: CreditCard[];
  statements: CreditCardStatement[];
  loans: Loan[];
  bills: Bill[];
  billEntries: BillEntry[];
  days?: number;
  asOf?: Date;
  /** Pre-resolved card states, so the ledger and this list cannot disagree. */
  cardStates?: CardState[];
}): UpcomingDue[] {
  const { cards, statements, loans, bills, billEntries, cardStates } = params;
  const days = params.days ?? 30;
  const asOf = params.asOf ?? new Date();
  const out: UpcomingDue[] = [];

  // --- Credit cards ---------------------------------------------------------
  if (cardStates) {
    for (const state of cardStates) {
      const { card } = state;
      out.push({
        id: `card-${card.id}`,
        kind: 'CARD',
        label: `${card.issuer} ${card.cardName}`,
        sublabel:
          state.source === 'NONE'
            ? `•••• ${card.last4} · nothing logged`
            : state.minimumDue > 0
              ? `•••• ${card.last4} · minimum ${formatCompactINR(state.minimumDue)}`
              : `•••• ${card.last4}`,
        amount: state.outstanding,
        dueDate: state.dueDate,
        daysUntil: daysUntilDue(state.dueDate, asOf),
        isOverdue: state.outstanding > 0 && daysUntilDue(state.dueDate, asOf) < 0,
        relatedId: card.id,
      });
    }
  } else {
    // Fallback: derive from the most recent unpaid statement.
    for (const card of cards.filter((c) => c.isActive)) {
      const unpaid = statements
        .filter((s) => s.cardId === card.id && s.status !== 'PAID')
        .sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];

      if (unpaid) {
        const outstanding = clampZero(unpaid.totalAmountDue - unpaid.totalPaid);
        if (outstanding > 0) {
          out.push({
            id: `card-${unpaid.id}`,
            kind: 'CARD',
            label: `${card.issuer} ${card.cardName}`,
            sublabel: unpaid.minimumDue > 0
              ? `•••• ${card.last4} · minimum ${formatCompactINR(unpaid.minimumDue)}`
              : `•••• ${card.last4}`,
            amount: outstanding,
            dueDate: unpaid.dueDate,
            daysUntil: daysUntilDue(unpaid.dueDate, asOf),
            isOverdue: daysUntilDue(unpaid.dueDate, asOf) < 0,
            relatedId: card.id,
          });
        }
      } else {
        const stmt = nextStatementDate(asOf, card.statementDay);
        const due = dueDateFor(stmt, card.dueDay);
        out.push({
          id: `card-next-${card.id}`,
          kind: 'CARD',
          label: `${card.issuer} ${card.cardName}`,
          sublabel: `•••• ${card.last4} · statement not logged`,
          amount: 0,
          dueDate: toISODate(due),
          daysUntil: daysUntilDue(due, asOf),
          isOverdue: false,
          relatedId: card.id,
        });
      }
    }
  }

  // Loans: the next EMI.
  for (const loan of loans.filter((l) => l.isActive)) {
    const thisMonth = dayOfMonthClamped(asOf, loan.emiDay);
    const due = thisMonth.getTime() >= toDate(asOf).getTime()
      ? thisMonth
      : dayOfMonthClamped(new Date(asOf.getFullYear(), asOf.getMonth() + 1, 1), loan.emiDay);

    out.push({
      id: `emi-${loan.id}`,
      kind: 'EMI',
      label: loan.loanName,
      sublabel: loan.lender,
      amount: loan.emiAmount,
      dueDate: toISODate(due),
      daysUntil: daysUntilDue(due, asOf),
      isOverdue: false,
      relatedId: loan.id,
    });
  }

  // Bills: anything still pending or already overdue.
  const billById = new Map(bills.map((b) => [b.id, b]));
  for (const entry of billEntries) {
    if (entry.status !== 'PENDING' && entry.status !== 'OVERDUE') continue;
    const bill = billById.get(entry.billId);
    if (!bill) continue;
    out.push({
      id: `bill-${entry.id}`,
      kind: 'BILL',
      label: bill.name,
      sublabel: bill.isAutopay ? 'Autopay' : bill.provider,
      amount: entry.amount,
      dueDate: entry.dueDate,
      daysUntil: daysUntilDue(entry.dueDate, asOf),
      isOverdue: daysUntilDue(entry.dueDate, asOf) < 0,
      relatedId: bill.id,
    });
  }

  return out
    .filter((d) => d.daysUntil <= days)
    .sort((a, b) => a.daysUntil - b.daysUntil || b.amount - a.amount);
}

// ---------------------------------------------------------------------------
// Debt
// ---------------------------------------------------------------------------

export interface DebtOverview {
  cardOutstanding: Paise;
  loanOutstanding: Paise;
  totalDebt: Paise;
  /** EMIs plus card minimums — what you must find every month. */
  monthlyObligation: Paise;
  /** How much of the original borrowing has been repaid, 0-100. */
  repaidPercent: number;
  totalBorrowed: Paise;
}

export function debtOverview(params: {
  cards: CreditCard[];
  statements: CreditCardStatement[];
  loans: Loan[];
  /** Pre-resolved card states. Pass these so the ledger and the dashboard agree. */
  cardStates?: CardState[];
  /** Pre-resolved loan states, so recorded EMIs drive the figure here too. */
  loanStates?: LoanState[];
}): DebtOverview {
  const { cards, statements, loans, cardStates, loanStates } = params;

  const states =
    cardStates ??
    cards
      .filter((c) => c.isActive)
      .map((c) => {
        const latest = statements
          .filter((s) => s.cardId === c.id)
          .sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];
        return {
          outstanding: latest ? clampZero(latest.totalAmountDue - latest.totalPaid) : 0,
          minimumDue: latest && latest.status !== 'PAID' ? latest.minimumDue : 0,
        };
      });

  const cardOutstanding = sumMoney(states.map((s) => s.outstanding));
  const cardMinimums = sumMoney(states.map((s) => s.minimumDue));

  const activeLoans = loans.filter((l) => l.isActive);
  const loanOutstanding = loanStates
    ? sumMoney(loanStates.map((s) => s.outstandingPrincipal))
    : sumMoney(activeLoans.map((l) => l.outstandingPrincipal));
  const emiTotal = sumMoney(activeLoans.map((l) => l.emiAmount));
  const totalBorrowed = sumMoney(activeLoans.map((l) => l.principalAmount));

  return {
    cardOutstanding,
    loanOutstanding,
    totalDebt: cardOutstanding + loanOutstanding,
    monthlyObligation: emiTotal + cardMinimums,
    repaidPercent:
      totalBorrowed > 0 ? percentage(clampZero(totalBorrowed - loanOutstanding), totalBorrowed) : 0,
    totalBorrowed,
  };
}

export interface CardHealth {
  card: CreditCard;
  outstanding: Paise;
  minimumDue: Paise;
  utilizationPercent: number;
  dueDate: ISODate;
  daysUntilDue: number;
  statementId?: string;
}

export function cardHealth(params: {
  cards: CreditCard[];
  statements: CreditCardStatement[];
  asOf?: Date;
  /** Pre-resolved card states, so this agrees with the card's own ledger. */
  cardStates?: CardState[];
}): CardHealth[] {
  const asOf = params.asOf ?? new Date();

  if (params.cardStates) {
    return params.cardStates
      .map((s) => ({
        card: s.card,
        outstanding: s.outstanding,
        minimumDue: s.minimumDue,
        utilizationPercent: s.utilizationPercent,
        dueDate: s.dueDate,
        daysUntilDue: daysUntilDue(s.dueDate, asOf),
        statementId: s.statementId,
      }))
      .sort((a, b) => b.utilizationPercent - a.utilizationPercent);
  }

  return params.cards
    .filter((c) => c.isActive)
    .map((card) => {
      const latest = params.statements
        .filter((s) => s.cardId === card.id)
        .sort((a, b) => b.statementDate.localeCompare(a.statementDate))[0];

      const outstanding = latest ? clampZero(latest.totalAmountDue - latest.totalPaid) : 0;
      const due = latest
        ? latest.dueDate
        : toISODate(dueDateFor(nextStatementDate(asOf, card.statementDay), card.dueDay));

      return {
        card,
        outstanding,
        minimumDue: latest && latest.status !== 'PAID' ? latest.minimumDue : 0,
        utilizationPercent: utilization(outstanding, card.creditLimit),
        dueDate: due,
        daysUntilDue: daysUntilDue(due, asOf),
        statementId: latest?.id,
      };
    })
    .sort((a, b) => b.utilizationPercent - a.utilizationPercent);
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

export interface CategorySpend {
  category: ExpenseCategory;
  amount: Paise;
  percent: number;
  count: number;
}

export function spendByCategory(expenses: Expense[], month?: MonthKey): CategorySpend[] {
  const rows = month ? expenses.filter((e) => e.date.startsWith(month)) : expenses;
  const total = sumMoney(rows.map((e) => e.amount));

  const byCategory = new Map<ExpenseCategory, { amount: Paise; count: number }>();
  for (const e of rows) {
    const cur = byCategory.get(e.category) ?? { amount: 0, count: 0 };
    cur.amount += e.amount;
    cur.count += 1;
    byCategory.set(e.category, cur);
  }

  return [...byCategory.entries()]
    .map(([category, v]) => ({
      category,
      amount: v.amount,
      count: v.count,
      percent: total > 0 ? percentage(v.amount, total) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export interface MonthlyTrendPoint {
  month: MonthKey;
  income: Paise;
  expenses: Paise;
  bills: Paise;
  emi: Paise;
  savings: Paise;
}

/** The 12-month income-vs-expense series behind the trend chart. */
export function monthlyTrend(params: {
  months?: number;
  income: Income[];
  expenses: Expense[];
  billEntries: BillEntry[];
  loans: Loan[];
  asOf?: Date;
}): MonthlyTrendPoint[] {
  const asOf = params.asOf ?? new Date();
  const months = lastNMonths(params.months ?? 12, asOf);

  const monthlyIncome = sumMoney(
    params.income.filter((i) => i.isActive).map((i) => monthlyEquivalent(i.amount, i.frequency)),
  );
  const monthlyEmi = sumMoney(params.loans.filter((l) => l.isActive).map((l) => l.emiAmount));

  return months.map((m) => {
    const expenses = sumMoney(params.expenses.filter((e) => e.date.startsWith(m)).map((e) => e.amount));
    const bills = sumMoney(
      params.billEntries.filter((b) => b.billingMonth === m && b.status !== 'SKIPPED').map((b) => b.amount),
    );
    return {
      month: m,
      income: monthlyIncome,
      expenses,
      bills,
      emi: monthlyEmi,
      savings: clampZero(monthlyIncome - expenses - bills - monthlyEmi),
    };
  });
}

/** Biggest recurring descriptions — the "where is it actually going" list. */
export function topMerchants(
  expenses: Expense[],
  month?: MonthKey,
  limit = 8,
): Array<{ description: string; amount: Paise; count: number }> {
  const rows = month ? expenses.filter((e) => e.date.startsWith(month)) : expenses;
  const byDesc = new Map<string, { amount: Paise; count: number }>();
  for (const e of rows) {
    const key = e.description.trim() || 'Unlabelled';
    const cur = byDesc.get(key) ?? { amount: 0, count: 0 };
    cur.amount += e.amount;
    cur.count += 1;
    byDesc.set(key, cur);
  }
  return [...byDesc.entries()]
    .map(([description, v]) => ({ description, ...v }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export interface BudgetProgress {
  budget: Budget;
  spent: Paise;
  remaining: Paise;
  percentUsed: number;
  isOver: boolean;
}

export function budgetProgress(
  budgets: Budget[],
  expenses: Expense[],
  month: MonthKey,
): BudgetProgress[] {
  const monthExpenses = expenses.filter((e) => e.date.startsWith(month));
  return budgets
    .filter((b) => b.month === month)
    .map((budget) => {
      const spent = sumMoney(
        monthExpenses.filter((e) => e.category === budget.category).map((e) => e.amount),
      );
      return {
        budget,
        spent,
        remaining: budget.limitAmount - spent,
        percentUsed: budget.limitAmount > 0 ? percentage(spent, budget.limitAmount) : 0,
        isOver: spent > budget.limitAmount,
      };
    })
    .sort((a, b) => b.percentUsed - a.percentUsed);
}

/** Total budget left this month, and what that means per remaining day. */
export function safeToSpend(
  budgets: Budget[],
  expenses: Expense[],
  month: MonthKey,
  asOf: Date = new Date(),
): { remaining: Paise; perDay: Paise; daysLeft: number } {
  const progress = budgetProgress(budgets, expenses, month);
  const remaining = clampZero(sumMoney(progress.map((p) => clampZero(p.remaining))));
  const daysLeft = daysLeftInMonth(asOf);
  return { remaining, perDay: daysLeft > 0 ? Math.round(remaining / daysLeft) : 0, daysLeft };
}

// ---------------------------------------------------------------------------
// Net worth
// ---------------------------------------------------------------------------

export interface NetWorth {
  investments: Paise;
  /** Cash in hand plus bank balances. Liquid, spendable today. */
  cash: Paise;
  investedPrincipal: Paise;
  gains: Paise;
  gainPercent: number;
  cardDebt: Paise;
  loanDebt: Paise;
  netWorth: Paise;
}

export function netWorth(params: {
  investments: Investment[];
  /** Optional so existing callers keep working; absent means no cash tracked. */
  cashAccounts?: CashAccount[];
  cards: CreditCard[];
  statements: CreditCardStatement[];
  loans: Loan[];
  cardStates?: CardState[];
  loanStates?: LoanState[];
}): NetWorth {
  const investmentValue = sumMoney(params.investments.map((i) => i.currentValue));
  const investedPrincipal = sumMoney(params.investments.map((i) => i.investedAmount));
  const liquid = totalLiquid(params.cashAccounts ?? []);
  const debt = debtOverview(params);

  return {
    investments: investmentValue,
    cash: liquid,
    investedPrincipal,
    gains: investmentValue - investedPrincipal,
    gainPercent: investedPrincipal > 0
      ? percentage(investmentValue - investedPrincipal, investedPrincipal)
      : 0,
    cardDebt: debt.cardOutstanding,
    loanDebt: debt.loanOutstanding,
    // Net worth was investments minus debt, which silently valued every rupee
    // of cash at zero. Someone with no investments and a full bank account read
    // as worth exactly their debt, negated.
    netWorth: investmentValue + liquid - debt.totalDebt,
  };
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface GoalProgress {
  goal: Goal;
  percentComplete: number;
  remaining: Paise;
  monthsLeft: number;
  /** What you need to put aside each month to land on the target date. */
  monthlyNeeded: Paise;
  onTrack: boolean;
}

export function goalProgress(goals: Goal[], asOf: Date = new Date()): GoalProgress[] {
  return goals.map((goal) => {
    const remaining = clampZero(goal.targetAmount - goal.currentAmount);
    const target = toDate(goal.targetDate);
    const monthsLeft = Math.max(
      0,
      (target.getFullYear() - asOf.getFullYear()) * 12 + (target.getMonth() - asOf.getMonth()),
    );
    const monthlyNeeded = monthsLeft > 0 ? Math.ceil(remaining / monthsLeft) : remaining;

    return {
      goal,
      percentComplete: goal.targetAmount > 0 ? percentage(goal.currentAmount, goal.targetAmount) : 0,
      remaining,
      monthsLeft,
      monthlyNeeded,
      onTrack: remaining === 0 || monthsLeft > 0,
    };
  });
}

/** Convenience: the current month key. */
export function currentMonth(asOf: Date = new Date()): MonthKey {
  return monthKey(asOf);
}
