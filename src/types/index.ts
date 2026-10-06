/**
 * PaisaTrack domain types.
 *
 * MONEY RULE: every monetary value in this app is an integer number of paise.
 * Rs 1,234.56 is stored as 123456. Floating point is never used for money.
 * See src/lib/finance/money.ts for the conversion and arithmetic helpers.
 */

/** Integer paise. 100 paise = Rs 1. */
export type Paise = number;

/** ISO date string, date-only: "2026-09-30". Stored this way so JSON round-trips cleanly. */
export type ISODate = string;

/** ISO timestamp: "2026-09-30T10:15:00.000Z". */
export type ISOTimestamp = string;

/** "2026-09" - the key used for monthly bucketing. */
export type MonthKey = string;

// ---------------------------------------------------------------------------
// Shared record envelope
// ---------------------------------------------------------------------------

export interface BaseRecord {
  id: string;
  createdAt: ISOTimestamp;
  updatedAt: ISOTimestamp;
  /** Set by the sync engine; last-write-wins uses updatedAt then deviceId. */
  deviceId?: string;
  /** Soft delete so deletions propagate through sync instead of silently resurrecting. */
  deletedAt?: ISOTimestamp | null;
}

// ---------------------------------------------------------------------------
// User and income
// ---------------------------------------------------------------------------

export interface User extends BaseRecord {
  name: string;
  email?: string;
  currency: 'INR';
  /** 4 = April, the Indian financial year start. */
  financialYearStartMonth: number;
}

export type IncomeType = 'SALARY' | 'BONUS' | 'FREELANCE' | 'INTEREST' | 'RENTAL' | 'OTHER';
export type IncomeFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'ONE_TIME';

export interface Income extends BaseRecord {
  userId: string;
  source: string;
  type: IncomeType;
  amount: Paise;
  frequency: IncomeFrequency;
  /** Day of month the income is credited (1-31), clamped to month length. */
  creditedOn?: number;
  effectiveFrom: ISODate;
  effectiveTo?: ISODate | null;
  isActive: boolean;
  notes?: string;
}

export interface SalaryProfile extends BaseRecord {
  userId: string;
  ctcAnnual: Paise;
  /** Percent of CTC that is Basic. Typically 40-50. */
  basicPercent: number;
  /** Percent of *Basic* that is HRA. Typically 40 (non-metro) or 50 (metro). */
  hraPercent: number;
  /** Employee PF contribution as percent of Basic. Statutory 12. */
  pfEmployeePercent: number;
  /** Employer PF contribution as percent of Basic. Statutory 12. Part of CTC. */
  pfEmployerPercent: number;
  /** Gratuity accrual as percent of Basic. Statutory ~4.81. Part of CTC. */
  gratuityPercent: number;
  professionalTaxMonthly: Paise;
  tdsMonthly: Paise;
  otherDeductionsMonthly: Paise;
  /** Cached output of ctcToInHand() so the dashboard does not recompute constantly. */
  inHandMonthly: Paise;
  effectiveFrom: ISODate;
}

// ---------------------------------------------------------------------------
// Credit cards
// ---------------------------------------------------------------------------

export type CardNetwork = 'VISA' | 'MASTERCARD' | 'RUPAY' | 'AMEX' | 'DINERS';

export interface CreditCard extends BaseRecord {
  userId: string;
  cardName: string;
  issuer: string;
  last4: string;
  creditLimit: Paise;
  /** Day of month the statement is generated (1-31). */
  statementDay: number;
  /** Day of month payment is due (1-31), normally in the month after the statement. */
  dueDay: number;
  /** Annual percentage rate, e.g. 45 for 3.75%/month. */
  apr: number;
  network?: CardNetwork;
  /** Minimum-due percentage this issuer applies. 5 for most, 2 for IndusInd. */
  madPercent: number;
  /** HDFC applies an alternate MAD formula - see calculateMinimumDue(). */
  madVariant: 'STANDARD' | 'HDFC';
  isActive: boolean;
  notes?: string;
}

export type CardTxnType = 'RETAIL' | 'CASH_ADVANCE' | 'EMI' | 'FEE' | 'REFUND';

export interface CardTransaction {
  id: string;
  date: ISODate;
  amount: Paise;
  type: CardTxnType;
  description?: string;
}

export interface CardPayment {
  id: string;
  date: ISODate;
  amount: Paise;
  notes?: string;
}

/**
 * A transaction on a card, stored independently of any statement.
 *
 * The interest engine needs a continuous history: a purchase made on 10-Apr can
 * be charged interest on the 18-May statement, so transactions cannot live
 * inside the statement they happen to fall in.
 */
export interface CardTxnRecord extends BaseRecord {
  cardId: string;
  date: ISODate;
  amount: Paise;
  type: CardTxnType;
  description?: string;
}

/** A payment made against a card, again independent of any one statement. */
export interface CardPaymentRecord extends BaseRecord {
  cardId: string;
  date: ISODate;
  amount: Paise;
  notes?: string;
}

export type StatementStatus = 'UNPAID' | 'PARTIAL' | 'MIN_PAID' | 'PAID' | 'OVERDUE';

export interface CreditCardStatement extends BaseRecord {
  cardId: string;
  statementMonth: MonthKey;
  statementDate: ISODate;
  dueDate: ISODate;
  previousStatementDate: ISODate;

  /** Balance carried into this cycle from the previous statement. */
  openingBalance: Paise;
  totalAmountDue: Paise;
  minimumDue: Paise;

  transactions: CardTransaction[];
  payments: CardPayment[];

  /** Cumulative amount paid against this statement. */
  totalPaid: Paise;
  /** True once payments have covered at least the minimum due, by the due date. */
  minimumPaid: boolean;

  interestCharged: Paise;
  lateFee: Paise;
  overlimitFee: Paise;
  cashAdvanceFee: Paise;
  gst: Paise;

  status: StatementStatus;
  /** True when this cycle lost its interest-free grace period. */
  revolving: boolean;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

export type LoanType = 'HOME' | 'CAR' | 'PERSONAL' | 'EDUCATION' | 'GOLD' | 'LAP' | 'OTHER';

export interface Loan extends BaseRecord {
  userId: string;
  loanName: string;
  lender: string;
  type: LoanType;
  principalAmount: Paise;
  /** Annual interest rate, e.g. 8.5. */
  interestRate: number;
  tenureMonths: number;
  emiAmount: Paise;
  startDate: ISODate;
  emiDay: number;
  outstandingPrincipal: Paise;
  isActive: boolean;
  notes?: string;
}

export interface LoanPayment extends BaseRecord {
  loanId: string;
  paidOn: ISODate;
  amount: Paise;
  principalComponent: Paise;
  interestComponent: Paise;
  isPrepayment: boolean;
  /** For prepayments: whether the saving is taken as a shorter tenure or a smaller EMI. */
  prepaymentMode?: 'REDUCE_TENURE' | 'REDUCE_EMI';
  installmentNumber?: number;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

export type BillCategory =
  | 'RENT' | 'ELECTRICITY' | 'WATER' | 'INTERNET' | 'MOBILE' | 'GAS'
  | 'DTH' | 'MAID' | 'COOK' | 'GYM' | 'SUBSCRIPTION' | 'INSURANCE' | 'OTHER';

export type BillFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
export type BillEntryStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'SKIPPED';

export interface Bill extends BaseRecord {
  userId: string;
  name: string;
  category: BillCategory;
  /** FIXED bills prefill the default amount; VARIABLE ones ask each month. */
  type: 'FIXED' | 'VARIABLE';
  defaultAmount: Paise;
  frequency: BillFrequency;
  dueDay: number;
  /** For QUARTERLY/ANNUAL: the month (1-12) of the first occurrence. */
  anchorMonth?: number;
  isAutopay: boolean;
  provider?: string;
  accountNumber?: string;
  /** Electricity bills additionally track units consumed. */
  tracksUnits?: boolean;
  isActive: boolean;
  notes?: string;
}

export interface BillEntry extends BaseRecord {
  billId: string;
  billingMonth: MonthKey;
  amount: Paise;
  dueDate: ISODate;
  unitsConsumed?: number;
  paidOn?: ISODate | null;
  status: BillEntryStatus;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

export type ExpenseCategory =
  | 'FOOD' | 'GROCERIES' | 'TRANSPORT' | 'FUEL' | 'SHOPPING' | 'ENTERTAINMENT'
  | 'HEALTH' | 'EDUCATION' | 'TRAVEL' | 'PERSONAL_CARE' | 'GIFTS' | 'HOUSEHOLD'
  | 'BILLS' | 'RENT' | 'EMI' | 'INVESTMENT' | 'FEES' | 'OTHER';

export type PaymentMethod =
  | 'CASH' | 'UPI' | 'DEBIT_CARD' | 'CREDIT_CARD' | 'NET_BANKING' | 'WALLET' | 'AUTO_DEBIT';

export interface Expense extends BaseRecord {
  userId: string;
  amount: Paise;
  category: ExpenseCategory;
  subcategory?: string;
  description: string;
  date: ISODate;
  paymentMethod: PaymentMethod;
  /** Required when paymentMethod is CREDIT_CARD - feeds card outstanding. */
  creditCardId?: string | null;
  isRecurring: boolean;
  tags?: string[];
  notes?: string;
}

// ---------------------------------------------------------------------------
// Investments, budgets, goals, reminders
// ---------------------------------------------------------------------------

export type InvestmentType =
  | 'SIP' | 'MUTUAL_FUND' | 'STOCKS' | 'PPF' | 'EPF' | 'FD' | 'RD'
  | 'NPS' | 'GOLD' | 'CRYPTO' | 'EMERGENCY_FUND' | 'OTHER';

export interface Investment extends BaseRecord {
  userId: string;
  name: string;
  type: InvestmentType;
  investedAmount: Paise;
  currentValue: Paise;
  startDate: ISODate;
  monthlyContribution: Paise;
  notes?: string;
}

export interface Budget extends BaseRecord {
  userId: string;
  month: MonthKey;
  category: ExpenseCategory;
  limitAmount: Paise;
  /** Carry unspent budget into next month. */
  rollover: boolean;
}

export type GoalType = 'EMERGENCY_FUND' | 'PURCHASE' | 'TRAVEL' | 'DEBT_FREE' | 'INVESTMENT' | 'OTHER';

export interface Goal extends BaseRecord {
  userId: string;
  name: string;
  targetAmount: Paise;
  currentAmount: Paise;
  targetDate: ISODate;
  type: GoalType;
  notes?: string;
}

export type ReminderRelatedType = 'CARD' | 'LOAN' | 'BILL' | 'GOAL' | 'NONE';

export interface Reminder extends BaseRecord {
  userId: string;
  title: string;
  dueDate: ISODate;
  relatedType: ReminderRelatedType;
  relatedId?: string;
  isDone: boolean;
  notifyDaysBefore: number;
}

// ---------------------------------------------------------------------------
// Sync bookkeeping
// ---------------------------------------------------------------------------

export type SyncTable =
  | 'users' | 'income' | 'salaryProfile' | 'creditCards' | 'statements'
  | 'cardTxns' | 'cardPayments'
  | 'loans' | 'loanPayments' | 'bills' | 'billEntries' | 'expenses'
  | 'investments' | 'budgets' | 'goals' | 'reminders';

export const SYNC_TABLES: SyncTable[] = [
  'users', 'income', 'salaryProfile', 'creditCards', 'statements',
  'cardTxns', 'cardPayments',
  'loans', 'loanPayments', 'bills', 'billEntries', 'expenses',
  'investments', 'budgets', 'goals', 'reminders',
];

export interface SyncQueueItem {
  id?: number;
  table: SyncTable;
  recordId: string;
  operation: 'PUT' | 'DELETE';
  queuedAt: ISOTimestamp;
}

export interface SyncMeta {
  table: string;
  lastPulledAt?: ISOTimestamp;
  lastPushedAt?: ISOTimestamp;
  /** Git blob SHA of the last data.json we read or wrote - used for optimistic concurrency. */
  remoteSha?: string;
}

export interface SyncConflict {
  id?: number;
  table: SyncTable;
  recordId: string;
  localValue: unknown;
  remoteValue: unknown;
  resolvedAs: 'LOCAL' | 'REMOTE';
  resolvedAt: ISOTimestamp;
}

/** Shape of the data.json committed to the private GitHub repo. */
export interface SyncPayload {
  schemaVersion: number;
  exportedAt: ISOTimestamp;
  deviceId: string;
  data: Record<SyncTable, BaseRecord[]>;
}

export interface LenderRate {
  name: string;
  rateMin: number;
  rateMax: number;
  /** Set when the monthly Action refreshed this entry from a public disclosure. */
  source?: string;
}

export interface LenderDatabase {
  home: LenderRate[];
  personal: LenderRate[];
  car: LenderRate[];
  education: LenderRate[];
  gold: LenderRate[];
  lap: LenderRate[];
  lastUpdated: ISODate;
}
