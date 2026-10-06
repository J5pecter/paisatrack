/**
 * Dexie (IndexedDB) schema — the local source of truth.
 *
 * Every read in the app comes from here, which is what makes PaisaTrack feel
 * instant and work offline. Writes land here first and are then queued for the
 * GitHub sync engine, so the UI never waits on the network.
 */
import Dexie, { type EntityTable } from 'dexie';
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
  SyncConflict,
  SyncMeta,
  SyncQueueItem,
  User,
} from '@/types';

export class PaisaTrackDB extends Dexie {
  users!: EntityTable<User, 'id'>;
  income!: EntityTable<Income, 'id'>;
  salaryProfile!: EntityTable<SalaryProfile, 'id'>;
  creditCards!: EntityTable<CreditCard, 'id'>;
  statements!: EntityTable<CreditCardStatement, 'id'>;
  cardTxns!: EntityTable<CardTxnRecord, 'id'>;
  cardPayments!: EntityTable<CardPaymentRecord, 'id'>;
  loans!: EntityTable<Loan, 'id'>;
  loanPayments!: EntityTable<LoanPayment, 'id'>;
  bills!: EntityTable<Bill, 'id'>;
  billEntries!: EntityTable<BillEntry, 'id'>;
  expenses!: EntityTable<Expense, 'id'>;
  investments!: EntityTable<Investment, 'id'>;
  budgets!: EntityTable<Budget, 'id'>;
  goals!: EntityTable<Goal, 'id'>;
  reminders!: EntityTable<Reminder, 'id'>;

  _syncQueue!: EntityTable<SyncQueueItem, 'id'>;
  _syncMeta!: EntityTable<SyncMeta, 'table'>;
  _syncConflicts!: EntityTable<SyncConflict, 'id'>;
  /** App settings, including the GitHub token. Kept in IndexedDB, never sent anywhere but api.github.com. */
  _settings!: EntityTable<{ key: string; value: unknown }, 'key'>;

  constructor(name = 'paisatrack') {
    super(name);

    this.version(1).stores({
      users: 'id, updatedAt',
      income: 'id, type, frequency, effectiveFrom, isActive, updatedAt',
      salaryProfile: 'id, userId, effectiveFrom, updatedAt',
      creditCards: 'id, issuer, isActive, updatedAt',
      statements: 'id, cardId, statementDate, statementMonth, status, updatedAt',
      loans: 'id, type, lender, isActive, updatedAt',
      loanPayments: 'id, loanId, paidOn, updatedAt',
      bills: 'id, category, isActive, updatedAt',
      billEntries: 'id, billId, billingMonth, status, dueDate, updatedAt',
      // The compound [category+date] index backs the dashboard's category rollups.
      expenses: 'id, category, date, paymentMethod, creditCardId, updatedAt, [category+date]',
      investments: 'id, type, updatedAt',
      budgets: 'id, month, category, updatedAt, [month+category]',
      goals: 'id, type, updatedAt',
      reminders: 'id, dueDate, isDone, updatedAt',

      _syncQueue: '++id, table, recordId, operation, queuedAt',
      _syncMeta: 'table',
      _syncConflicts: '++id, table, recordId, resolvedAt',
      _settings: 'key',
    });

    // v2 adds card-level transactions and payments. They live outside the
    // statement because the interest engine needs a continuous history that
    // spans statement boundaries. Dexie carries v1 data forward untouched.
    this.version(2).stores({
      cardTxns: 'id, cardId, date, type, updatedAt, [cardId+date]',
      cardPayments: 'id, cardId, date, updatedAt, [cardId+date]',
    });
  }
}

export const db = new PaisaTrackDB();

/** Wipe every table. Used by "reset app" and by the tests. */
export async function clearAllData(target: PaisaTrackDB = db): Promise<void> {
  await target.transaction('rw', target.tables, async () => {
    await Promise.all(target.tables.map((t) => t.clear()));
  });
}
