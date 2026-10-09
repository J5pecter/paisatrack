/**
 * Live data hooks.
 *
 * Every screen reads through these. They used to sit on `useLiveQuery` over
 * IndexedDB; they sit on the in-memory record store now, which is filled once
 * from the Worker and updated after each confirmed write. The signatures did
 * not change, so neither did any page.
 *
 * ## Atomicity, still
 *
 * The old implementation went to some trouble to read every table in ONE live
 * query, because a dozen independent queries resolve independently and the
 * dashboard would briefly render real income against zero spending — a
 * half-loaded balance sheet that is wrong rather than merely incomplete.
 *
 * That property survives, and is now structural rather than careful: the store
 * sets every table before it notifies once, so there is no moment at which a
 * subscriber can observe some tables loaded and others not.
 *
 * ## Why useSyncExternalStore and not useState
 *
 * The getter must return the same reference until that table actually changes.
 * The store keeps one frozen array per table and replaces only the ones a write
 * touched, so a new expense re-renders the expense screens and leaves the loan
 * screens alone — and the `useMemo`s below keep their cached sorts.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getStatus, getTable, subscribe } from '@/lib/store/records';
import type { BaseRecord, SyncTable } from '@/types';
import type {
  Bill,
  BillEntry,
  Budget,
  CardPaymentRecord,
  CardTxnRecord,
  CashAccount,
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

/**
 * Tombstones never reach the UI.
 *
 * Kept even though the server no longer soft-deletes anything: records migrated
 * out of an older IndexedDB copy can still carry a `deletedAt`, and a deleted
 * expense reappearing after a migration would be a genuinely alarming bug.
 */
function live<T extends { deletedAt?: string | null }>(rows: readonly T[] | undefined): T[] {
  return (rows ?? []).filter((r) => !r.deletedAt);
}

/**
 * What each table holds.
 *
 * One place where a table name maps to its record type, so `useTable('loans')`
 * is `Loan[]` without a call-site generic — and so a typo in a table name is a
 * compile error rather than an empty list at runtime.
 */
interface TableTypes {
  expenses: Expense;
  creditCards: CreditCard;
  statements: CreditCardStatement;
  cardTxns: CardTxnRecord;
  cardPayments: CardPaymentRecord;
  loans: Loan;
  loanPayments: LoanPayment;
  bills: Bill;
  billEntries: BillEntry;
  income: Income;
  salaryProfile: SalaryProfile;
  cashAccounts: CashAccount;
  investments: Investment;
  budgets: Budget;
  goals: Goal;
  reminders: Reminder;
}

/**
 * Subscribe to one table.
 *
 * `getTable` is referentially stable between changes to that table, which is
 * what `useSyncExternalStore` requires — a getter that built a fresh array
 * each call would re-render every subscriber on every render, forever.
 */
function useTable<K extends keyof TableTypes>(table: K): readonly TableTypes[K][] {
  const get = () => getTable<TableTypes[K] & BaseRecord>(table as SyncTable);
  return useSyncExternalStore(subscribe, get, get);
}

export function useExpenses(): Expense[] {
  const rows = useTable('expenses');
  return useMemo(() => live(rows).sort((a, b) => b.date.localeCompare(a.date)), [rows]);
}

export function useCreditCards(): CreditCard[] {
  const rows = useTable('creditCards');
  return useMemo(() => live(rows), [rows]);
}

export function useStatements(cardId?: string): CreditCardStatement[] {
  const rows = useTable('statements');
  return useMemo(() => {
    const all = live(rows).sort((a, b) => b.statementDate.localeCompare(a.statementDate));
    return cardId ? all.filter((s) => s.cardId === cardId) : all;
  }, [rows, cardId]);
}

/** Every transaction on a card, oldest first — the order the ledger wants. */
export function useCardTxns(cardId?: string): CardTxnRecord[] {
  const rows = useTable('cardTxns');
  return useMemo(() => {
    const all = live(rows).sort((a, b) => a.date.localeCompare(b.date));
    return cardId ? all.filter((t) => t.cardId === cardId) : all;
  }, [rows, cardId]);
}

export function useCardPayments(cardId?: string): CardPaymentRecord[] {
  const rows = useTable('cardPayments');
  return useMemo(() => {
    const all = live(rows).sort((a, b) => a.date.localeCompare(b.date));
    return cardId ? all.filter((p) => p.cardId === cardId) : all;
  }, [rows, cardId]);
}

export function useLoans(): Loan[] {
  const rows = useTable('loans');
  return useMemo(() => live(rows), [rows]);
}

export function useLoanPayments(loanId?: string): LoanPayment[] {
  const rows = useTable('loanPayments');
  return useMemo(() => {
    const all = live(rows).sort((a, b) => b.paidOn.localeCompare(a.paidOn));
    return loanId ? all.filter((p) => p.loanId === loanId) : all;
  }, [rows, loanId]);
}

export function useBills(): Bill[] {
  const rows = useTable('bills');
  return useMemo(() => live(rows), [rows]);
}

export function useBillEntries(month?: string): BillEntry[] {
  const rows = useTable('billEntries');
  return useMemo(() => {
    const all = live(rows);
    return month ? all.filter((e) => e.billingMonth === month) : all;
  }, [rows, month]);
}

export function useIncome(): Income[] {
  const rows = useTable('income');
  return useMemo(() => live(rows), [rows]);
}

export function useSalaryProfile(): SalaryProfile | undefined {
  const rows = useTable('salaryProfile');
  return useMemo(
    () => live(rows).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0],
    [rows],
  );
}

export function useCashAccounts(): CashAccount[] {
  const rows = useTable('cashAccounts');
  // Cash before bank, then by name: the wallet is what you check first.
  return useMemo(
    () =>
      live(rows).sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'CASH' ? -1 : 1,
      ),
    [rows],
  );
}

export function useInvestments(): Investment[] {
  const rows = useTable('investments');
  return useMemo(() => live(rows), [rows]);
}

export function useBudgets(month?: string): Budget[] {
  const rows = useTable('budgets');
  return useMemo(() => {
    const all = live(rows);
    return month ? all.filter((b) => b.month === month) : all;
  }, [rows, month]);
}

export function useGoals(): Goal[] {
  const rows = useTable('goals');
  return useMemo(() => live(rows), [rows]);
}

export function useReminders(): Reminder[] {
  const rows = useTable('reminders');
  return useMemo(() => live(rows), [rows]);
}

/** Has anything at all been entered? Drives the first-run experience. */
export function useHasData(): boolean | undefined {
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);
  const expenses = useTable('expenses');
  const cards = useTable('creditCards');
  const bills = useTable('bills');
  const loans = useTable('loans');
  const income = useTable('income');

  // `undefined` while the first fetch is in flight, so the first-run screen
  // does not flash "nothing here yet" at someone who has three years of data
  // arriving over a slow connection.
  if (status === 'LOADING' || status === 'IDLE') return undefined;

  return (
    live(expenses).length +
      live(cards).length +
      live(bills).length +
      live(loans).length +
      live(income).length >
    0
  );
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
  cashAccounts: CashAccount[];
}

const EMPTY_DASHBOARD: DashboardData = {
  expenses: [], loanPayments: [], cards: [], statements: [], cardTxns: [], cardPayments: [],
  loans: [], bills: [], billEntries: [], income: [], investments: [], budgets: [], goals: [],
  cashAccounts: [],
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
  const status = useSyncExternalStore(subscribe, getStatus, getStatus);

  const expenses = useTable('expenses');
  const cards = useTable('creditCards');
  const statements = useTable('statements');
  const cardTxns = useTable('cardTxns');
  const cardPayments = useTable('cardPayments');
  const loans = useTable('loans');
  const loanPayments = useTable('loanPayments');
  const bills = useTable('bills');
  const billEntries = useTable('billEntries');
  const income = useTable('income');
  const investments = useTable('investments');
  const budgets = useTable('budgets');
  const goals = useTable('goals');
  const cashAccounts = useTable('cashAccounts');

  const data = useMemo(() => {
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
      cashAccounts: live(cashAccounts),
    };
  }, [
    expenses, cards, statements, cardTxns, cardPayments, loans, loanPayments,
    bills, billEntries, income, investments, budgets, goals, cashAccounts,
  ]);

  /*
    Loading means "the first fetch has not finished", not "there is no data".
    Every consumer uses it to hold off rendering figures, and rendering zeros
    while the request is in flight would show a net worth of ₹0 to someone who
    has one.
  */
  const isLoading = status === 'LOADING' || status === 'IDLE';
  return { ...(isLoading ? EMPTY_DASHBOARD : data), isLoading };
}
