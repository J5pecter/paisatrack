/**
 * Live data hooks.
 *
 * `useLiveQuery` re-renders whenever the underlying IndexedDB table changes, so
 * a write anywhere in the app updates every screen showing that data — no
 * refetching, no cache invalidation, no stale views.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/lib/db/schema';
import type {
  Bill,
  BillEntry,
  Budget,
  CardPaymentRecord,
  CardTxnRecord,
  CreditCard,
  CreditCardStatement,
  Expense,
  Goal,
  Income,
  Investment,
  Loan,
  LoanPayment,
  Reminder,
  SalaryProfile,
} from '@/types';

/** Tombstones never reach the UI. */
function live<T extends { deletedAt?: string | null }>(rows: T[] | undefined): T[] {
  return (rows ?? []).filter((r) => !r.deletedAt);
}

export function useExpenses(): Expense[] {
  const rows = useLiveQuery(() => db.expenses.toArray(), []);
  return useMemo(() => live(rows).sort((a, b) => b.date.localeCompare(a.date)), [rows]);
}

export function useCreditCards(): CreditCard[] {
  const rows = useLiveQuery(() => db.creditCards.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useStatements(cardId?: string): CreditCardStatement[] {
  const rows = useLiveQuery(() => db.statements.toArray(), []);
  return useMemo(() => {
    const all = live(rows).sort((a, b) => b.statementDate.localeCompare(a.statementDate));
    return cardId ? all.filter((s) => s.cardId === cardId) : all;
  }, [rows, cardId]);
}

/** Every transaction on a card, oldest first — the order the ledger wants. */
export function useCardTxns(cardId?: string): CardTxnRecord[] {
  const rows = useLiveQuery(() => db.cardTxns.toArray(), []);
  return useMemo(() => {
    const all = live(rows).sort((a, b) => a.date.localeCompare(b.date));
    return cardId ? all.filter((t) => t.cardId === cardId) : all;
  }, [rows, cardId]);
}

export function useCardPayments(cardId?: string): CardPaymentRecord[] {
  const rows = useLiveQuery(() => db.cardPayments.toArray(), []);
  return useMemo(() => {
    const all = live(rows).sort((a, b) => a.date.localeCompare(b.date));
    return cardId ? all.filter((p) => p.cardId === cardId) : all;
  }, [rows, cardId]);
}

export function useLoans(): Loan[] {
  const rows = useLiveQuery(() => db.loans.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useLoanPayments(loanId?: string): LoanPayment[] {
  const rows = useLiveQuery(() => db.loanPayments.toArray(), []);
  return useMemo(() => {
    const all = live(rows).sort((a, b) => b.paidOn.localeCompare(a.paidOn));
    return loanId ? all.filter((p) => p.loanId === loanId) : all;
  }, [rows, loanId]);
}

export function useBills(): Bill[] {
  const rows = useLiveQuery(() => db.bills.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useBillEntries(month?: string): BillEntry[] {
  const rows = useLiveQuery(() => db.billEntries.toArray(), []);
  return useMemo(() => {
    const all = live(rows);
    return month ? all.filter((e) => e.billingMonth === month) : all;
  }, [rows, month]);
}

export function useIncome(): Income[] {
  const rows = useLiveQuery(() => db.income.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useSalaryProfile(): SalaryProfile | undefined {
  const rows = useLiveQuery(() => db.salaryProfile.toArray(), []);
  return useMemo(
    () => live(rows).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0],
    [rows],
  );
}

export function useInvestments(): Investment[] {
  const rows = useLiveQuery(() => db.investments.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useBudgets(month?: string): Budget[] {
  const rows = useLiveQuery(() => db.budgets.toArray(), []);
  return useMemo(() => {
    const all = live(rows);
    return month ? all.filter((b) => b.month === month) : all;
  }, [rows, month]);
}

export function useGoals(): Goal[] {
  const rows = useLiveQuery(() => db.goals.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

export function useReminders(): Reminder[] {
  const rows = useLiveQuery(() => db.reminders.toArray(), []);
  return useMemo(() => live(rows), [rows]);
}

/** Has anything at all been entered? Drives the first-run experience. */
export function useHasData(): boolean | undefined {
  return useLiveQuery(async () => {
    const [e, c, b, l, i] = await Promise.all([
      db.expenses.count(),
      db.creditCards.count(),
      db.bills.count(),
      db.loans.count(),
      db.income.count(),
    ]);
    return e + c + b + l + i > 0;
  }, []);
}

export interface DashboardData {
  expenses: Expense[];
  loanPayments: LoanPayment[];
  cards: CreditCard[];
  statements: CreditCardStatement[];
  cardTxns: CardTxnRecord[];
  cardPayments: CardPaymentRecord[];
  loans: Loan[];
  bills: Bill[];
  billEntries: BillEntry[];
  income: Income[];
  investments: Investment[];
  budgets: Budget[];
  goals: Goal[];
}

const EMPTY_DASHBOARD: DashboardData = {
  expenses: [], loanPayments: [], cards: [], statements: [], cardTxns: [], cardPayments: [],
  loans: [], bills: [], billEntries: [], income: [], investments: [], budgets: [], goals: [],
};

/**
 * Everything the dashboard needs, read as one consistent snapshot.
 *
 * Deliberately a single live query rather than a dozen separate ones. With
 * separate queries the tables resolve independently, so for a frame or two the
 * dashboard would render real income against zero spending — a half-loaded
 * balance sheet that is wrong rather than merely incomplete. One query means
 * the figures arrive together or not at all.
 */
export function useDashboardData(): DashboardData & { isLoading: boolean } {
  const data = useLiveQuery(async () => {
    const [
      expenses, cards, statements, cardTxns, cardPayments,
      loans, loanPayments, bills, billEntries, income, investments, budgets, goals,
    ] = await Promise.all([
      db.expenses.toArray(),
      db.creditCards.toArray(),
      db.statements.toArray(),
      db.cardTxns.toArray(),
      db.cardPayments.toArray(),
      db.loans.toArray(),
      db.loanPayments.toArray(),
      db.bills.toArray(),
      db.billEntries.toArray(),
      db.income.toArray(),
      db.investments.toArray(),
      db.budgets.toArray(),
      db.goals.toArray(),
    ]);

    return {
      expenses: live(expenses).sort((a, b) => b.date.localeCompare(a.date)),
      cards: live(cards),
      statements: live(statements).sort((a, b) => b.statementDate.localeCompare(a.statementDate)),
      cardTxns: live(cardTxns).sort((a, b) => a.date.localeCompare(b.date)),
      cardPayments: live(cardPayments).sort((a, b) => a.date.localeCompare(b.date)),
      loans: live(loans),
      loanPayments: live(loanPayments).sort((a, b) => a.paidOn.localeCompare(b.paidOn)),
      bills: live(bills),
      billEntries: live(billEntries),
      income: live(income),
      investments: live(investments),
      budgets: live(budgets),
      goals: live(goals),
    };
  }, []);

  return { ...(data ?? EMPTY_DASHBOARD), isLoading: data === undefined };
}
