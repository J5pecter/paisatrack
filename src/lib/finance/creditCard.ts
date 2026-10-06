/**
 * Credit card interest engine.
 *
 * Indian issuers (HDFC, ICICI, SBI, Axis, Kotak) all charge on the Average
 * Daily Balance with a daily rate of APR/365:
 *
 *     interest = balance * (APR/100) * days / 365
 *
 * The part that trips people up is the interest-free period. Pay the statement
 * in full by the due date and retail spends cost nothing. Pay even one rupee
 * less and you lose the grace period *retroactively, from each transaction
 * date* - not from the statement date. That retroactive loss is why this engine
 * cannot work one statement at a time: a purchase made on 10-Apr can be charged
 * interest on the 18-May statement. So we simulate a continuous day-by-day
 * ledger of open "lots", each remembering the date it originated.
 *
 * Every lot accrues interest from its own origination date. At each due date we
 * find out whether grace was earned; if it was, the provisional interest on
 * grace-eligible lots is waived. If it was not, the interest stands and every
 * open lot loses grace permanently. This models the real behaviour exactly,
 * including the case where a purchase predates the statement it is billed on.
 */
import Big from 'big.js';
import type {
  CardPayment,
  CardTransaction,
  CardTxnType,
  ISODate,
  Paise,
  StatementStatus,
} from '@/types';
import {
  addDays,
  currentStatementDate,
  dueDateFor,
  monthKey,
  nextStatementDate,
  toDate,
  toISODate,
} from './dates';
import { clampZero, maxMoney, pctOf, sumMoney } from './money';

// ---------------------------------------------------------------------------
// Fee schedules (see spec sections 7.8 / 7.9)
// ---------------------------------------------------------------------------

export const GST_RATE = 18;

/** Late payment fee slabs by outstanding amount, in paise. */
const LATE_FEE_SLABS: Array<{ upto: Paise; fee: Paise }> = [
  { upto: 9_999, fee: 0 },             // < Rs 100  -> nil (Rs 100 itself is charged)
  { upto: 50_000, fee: 10_000 },       // Rs 100-500 -> Rs 100
  { upto: 5_00_000, fee: 50_000 },     // Rs 501-5,000 -> Rs 500
  { upto: 10_00_000, fee: 70_000 },    // Rs 5,001-10,000 -> Rs 700
  { upto: 25_00_000, fee: 1_00_000 },  // Rs 10,001-25,000 -> Rs 1,000
  { upto: Infinity, fee: 1_30_000 },   // > Rs 25,000 -> Rs 1,300
];

export function lateFeeFor(outstanding: Paise): Paise {
  if (outstanding <= 0) return 0;
  for (const slab of LATE_FEE_SLABS) {
    if (outstanding <= slab.upto) return slab.fee;
  }
  return 1_30_000;
}

/** 2.5% of the amount over limit, minimum Rs 500. */
export function overlimitFeeFor(excess: Paise): Paise {
  if (excess <= 0) return 0;
  return maxMoney(pctOf(excess, 2.5), 50_000);
}

/** 2.5% of the withdrawal, minimum Rs 500. */
export function cashAdvanceFeeFor(amount: Paise): Paise {
  if (amount <= 0) return 0;
  return maxMoney(pctOf(amount, 2.5), 50_000);
}

/** GST at 18% on interest and fees. */
export function gstOn(amount: Paise): Paise {
  return pctOf(amount, GST_RATE);
}

// ---------------------------------------------------------------------------
// Minimum Amount Due
// ---------------------------------------------------------------------------

export interface MinimumDueInput {
  /** Full statement balance. */
  totalOutstanding: Paise;
  /** Portion already converted to EMI - 100% of it is always due. */
  emiAmount?: Paise;
  gst?: Paise;
  fees?: Paise;
  /** Interest charged on this statement. */
  financeCharges?: Paise;
  /** Amount by which the balance exceeds the credit limit. */
  overlimitAmount?: Paise;
  retailSpends?: Paise;
  cashAdvance?: Paise;
  /** Issuer percentage applied to the residual balance. 5 for most, 2 for IndusInd. */
  madPercent?: number;
  /** Absolute floor, default Rs 500. */
  floor?: Paise;
  /** HDFC applies an alternate 30%-based formula for some cards. */
  variant?: 'STANDARD' | 'HDFC';
}

/**
 * Minimum Amount Due.
 *
 *   MAD = 100% of EMI + GST + fees + finance charges + overlimit
 *       + X% of (retail + cash advance + remaining balance)
 *
 * HDFC variant: if 30% of (finance charge + retail spends) exceeds the finance
 * charge, MAD = GST + fees + 30% of (finance charge + retail spends).
 *
 * The result is never more than the total outstanding - you cannot be asked for
 * more than you owe - and never less than the floor unless the balance itself
 * is below the floor.
 */
export function calculateMinimumDue(input: MinimumDueInput): Paise {
  const {
    totalOutstanding,
    emiAmount = 0,
    gst = 0,
    fees = 0,
    financeCharges = 0,
    overlimitAmount = 0,
    retailSpends = 0,
    madPercent = 5,
    floor = 50_000,
    variant = 'STANDARD',
  } = input;

  if (totalOutstanding <= 0) return 0;

  let mad: Paise;

  if (variant === 'HDFC') {
    const thirtyPct = pctOf(financeCharges + retailSpends, 30);
    // HDFC's alternate formula is an additional floor, not a replacement -
    // substituting it would silently drop the 100%-mandatory EMI and overlimit
    // components and the percentage of any carried-forward balance.
    const alternate = thirtyPct > financeCharges ? gst + fees + thirtyPct : 0;
    mad = maxMoney(computeStandardMad(), alternate);
  } else {
    mad = computeStandardMad();
  }

  // The floor only binds while the balance is above it.
  if (totalOutstanding <= floor) return totalOutstanding;
  mad = maxMoney(mad, floor);

  return Math.min(mad, totalOutstanding);

  function computeStandardMad(): Paise {
    const mandatory = emiAmount + gst + fees + financeCharges + overlimitAmount;
    // The percentage applies to whatever is left after the mandatory components.
    // That residual is exactly retail + cash advance + balance carried forward,
    // so those do not need adding separately.
    const residual = clampZero(totalOutstanding - mandatory);
    return mandatory + pctOf(residual, madPercent);
  }
}

// ---------------------------------------------------------------------------
// Continuous ledger
// ---------------------------------------------------------------------------

type LotType = CardTxnType | 'INTEREST';

interface Lot {
  id: string;
  /** Date the amount originated - interest accrues from here. */
  date: Date;
  type: LotType;
  /** Remaining unpaid amount of this lot. */
  balance: Paise;
  /** Interest accrued so far on this lot but not yet billed. */
  accrued: Big;
  /**
   * Whether this lot can still earn the interest-free period. Cash advances
   * never can; retail lots created while revolving never can; and every open
   * lot loses it the moment a statement goes unpaid past its due date.
   */
  graceEligible: boolean;
}

export interface ComputedStatement {
  statementMonth: string;
  statementDate: ISODate;
  dueDate: ISODate;
  previousStatementDate: ISODate;

  openingBalance: Paise;
  /** Spend posted during this cycle, split by type. */
  retailSpends: Paise;
  cashAdvances: Paise;
  emiSpends: Paise;
  refunds: Paise;
  paymentsInCycle: Paise;

  interestCharged: Paise;
  lateFee: Paise;
  overlimitFee: Paise;
  cashAdvanceFee: Paise;
  gst: Paise;

  totalAmountDue: Paise;
  minimumDue: Paise;

  /** Payments received between this statement date and its due date. */
  paidByDueDate: Paise;
  paidInFull: boolean;
  minimumPaid: boolean;
  status: StatementStatus;
  /** True when this cycle carried a balance past its due date. */
  revolving: boolean;

  utilizationPercent: number;
}

export interface LedgerInput {
  statementDay: number;
  dueDay: number;
  apr: number;
  creditLimit: Paise;
  madPercent?: number;
  madVariant?: 'STANDARD' | 'HDFC';
  transactions: CardTransaction[];
  payments: CardPayment[];
  /** Simulate up to this date. Defaults to today. */
  asOf?: ISODate;
  /**
   * Seed the revolving flag. Set this when the caller already knows the
   * previous statement went unpaid, so spend in this cycle correctly loses its
   * grace period from day one.
   */
  initialRevolving?: boolean;
  /**
   * Suppress statements before this date.
   *
   * The simulation still has to begin early enough to cover every transaction's
   * origination date, but a caller who only wants one cycle does not want the
   * earlier cycles cut as statements — that would bill part of the interest
   * away before the cycle they asked about. Lots simply keep accruing instead.
   */
  emitStatementsFrom?: ISODate;
  /**
   * Where the simulation starts. Defaults to the statement date immediately
   * before the earliest transaction, so the first cycle is complete.
   */
  from?: ISODate;
}

export interface LedgerResult {
  statements: ComputedStatement[];
  /** Balance owed right now, including unbilled spend and accrued interest. */
  currentOutstanding: Paise;
  /** Interest accrued since the last statement but not yet billed. */
  unbilledInterest: Paise;
  currentUtilizationPercent: number;
  /** True if the card is currently carrying a revolving balance. */
  revolving: boolean;
  totalInterestPaid: Paise;
  totalFeesPaid: Paise;
  nextStatementDate: ISODate;
  nextDueDate: ISODate;
}

/**
 * Run the full day-by-day ledger for one card.
 *
 * Payment appropriation follows the order issuers publish: fees and taxes
 * first, then interest, then EMI, then cash advances, then retail - oldest lot
 * first within each bucket.
 */
export function runCardLedger(input: LedgerInput): LedgerResult {
  const {
    statementDay,
    dueDay,
    apr,
    creditLimit,
    madPercent = 5,
    madVariant = 'STANDARD',
    transactions,
    payments,
  } = input;

  const asOf = toDate(input.asOf ?? new Date());
  const emitFrom = input.emitStatementsFrom ? toDate(input.emitStatementsFrom) : null;
  const dailyRate = new Big(apr).div(100).div(365);

  const txns = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const pays = [...payments].sort((a, b) => a.date.localeCompare(b.date));

  if (txns.length === 0 && pays.length === 0) {
    const ns = nextStatementDate(asOf, statementDay);
    return {
      statements: [],
      currentOutstanding: 0,
      unbilledInterest: 0,
      currentUtilizationPercent: 0,
      revolving: false,
      totalInterestPaid: 0,
      totalFeesPaid: 0,
      nextStatementDate: toISODate(ns),
      nextDueDate: toISODate(dueDateFor(ns, dueDay)),
    };
  }

  const earliest = txns.length
    ? toDate(txns[0].date)
    : toDate(pays[0].date);
  const start = input.from
    ? toDate(input.from)
    : currentStatementDate(earliest, statementDay);

  // Index events by ISO date for O(1) lookup inside the day loop.
  const txnsByDate = new Map<string, CardTransaction[]>();
  for (const t of txns) {
    const k = t.date;
    (txnsByDate.get(k) ?? txnsByDate.set(k, []).get(k)!).push(t);
  }
  const paysByDate = new Map<string, CardPayment[]>();
  for (const p of pays) {
    const k = p.date;
    (paysByDate.get(k) ?? paysByDate.set(k, []).get(k)!).push(p);
  }

  let lots: Lot[] = [];
  let revolving = input.initialRevolving ?? false;
  let lotSeq = 0;
  /**
   * Overpayment sitting on the card, held as a single positive number rather
   * than a negative lot. A negative lot would be skipped by the accrual loop
   * and never consumed by a later purchase, so interest would be charged on
   * the gross spend instead of the net balance.
   */
  let creditBalance: Paise = 0;

  const statements: ComputedStatement[] = [];
  /** Statements awaiting their due-date verdict. */
  const pendingDueChecks: Array<{ stmt: ComputedStatement; dueDate: Date }> = [];

  let cycleStart = start;
  let cycleRetail = 0;
  let cycleCash = 0;
  let cycleEmi = 0;
  let cycleRefunds = 0;
  let cyclePayments = 0;
  let cycleCashAdvanceFee = 0;
  /**
   * Fees assessed at a due date (late fees), which are billed on the NEXT
   * statement. Kept apart from cycleCashAdvanceFee so they still attract GST
   * and count as a 100%-mandatory component of the minimum due.
   */
  let cycleCarriedFees = 0;
  let openingBalance = 0;
  let totalInterestPaid = 0;
  let totalFeesPaid = 0;

  let day = start;
  // Hard bound: 40 years of daily simulation. Protects the UI from a bad date.
  const MAX_DAYS = 365 * 40;
  let guard = 0;

  while (day.getTime() <= asOf.getTime() && guard++ < MAX_DAYS) {
    const iso = toISODate(day);

    // --- 1. Post transactions dated today (they accrue from today onward) ---
    for (const t of txnsByDate.get(iso) ?? []) {
      if (t.type === 'REFUND') {
        cycleRefunds += t.amount;
        applyCredit(t.amount);
        continue;
      }
      const isCash = t.type === 'CASH_ADVANCE';

      // Spend a sitting credit balance first, so only the net amount accrues.
      const offset = Math.min(creditBalance, t.amount);
      creditBalance -= offset;
      const lotAmount = t.amount - offset;

      if (lotAmount > 0) {
        lots.push({
          id: `lot-${lotSeq++}`,
          date: day,
          type: t.type,
          balance: lotAmount,
          accrued: new Big(0),
          // Cash advances never get grace. Retail loses it if already revolving.
          graceEligible: !isCash && !revolving,
        });
      }
      if (isCash) {
        cycleCash += t.amount;
        const fee = cashAdvanceFeeFor(t.amount);
        cycleCashAdvanceFee += fee;
      } else if (t.type === 'EMI') {
        cycleEmi += t.amount;
      } else if (t.type === 'RETAIL') {
        cycleRetail += t.amount;
      } else {
        cycleRetail += t.amount; // FEE posted by the issuer mid-cycle
      }
    }

    // --- 2. Apply payments dated today (they stop accruing from today) ---
    for (const p of paysByDate.get(iso) ?? []) {
      cyclePayments += p.amount;
      applyCredit(p.amount);
    }

    // --- 3. Due-date verdicts for statements whose due date is today ---
    for (let i = pendingDueChecks.length - 1; i >= 0; i--) {
      const pending = pendingDueChecks[i];
      if (pending.dueDate.getTime() !== day.getTime()) continue;
      settleDueDate(pending.stmt);
      pendingDueChecks.splice(i, 1);
    }

    // --- 4. Statement generation ---
    // Runs *before* today's accrual so a lot originating on day X and billed on
    // statement day Y is charged exactly daysBetween(X, Y) days of interest.
    if (isStatementDay(day) && (!emitFrom || day.getTime() >= emitFrom.getTime())) {
      const hadActivity =
        openingBalance > 0 || cycleRetail > 0 || cycleCash > 0 || cycleEmi > 0 ||
        cyclePayments > 0 || cycleRefunds > 0 || lots.some((l) => l.balance !== 0);
      const stmt = generateStatement(day);
      // Suppress the dead statement before the card was ever used.
      if (hadActivity) {
        statements.push(stmt);
        pendingDueChecks.push({ stmt, dueDate: toDate(stmt.dueDate) });
      }
    }

    // --- 5. Accrue one day of interest on every open lot ---
    for (const lot of lots) {
      if (lot.balance > 0) lot.accrued = lot.accrued.plus(dailyRate.times(lot.balance));
    }

    day = addDays(day, 1);
  }

  // Statements whose due date has not arrived yet still need a provisional verdict.
  for (const pending of pendingDueChecks) {
    const paid = paymentsBetween(toDate(pending.stmt.statementDate), asOf);
    pending.stmt.paidByDueDate = paid;
    pending.stmt.paidInFull = paid >= pending.stmt.totalAmountDue;
    pending.stmt.minimumPaid = paid >= pending.stmt.minimumDue;
    pending.stmt.status = deriveStatus(pending.stmt, false);
  }

  const outstanding = sumMoney(lots.map((l) => l.balance)) - creditBalance;
  const unbilled = Number(
    lots.reduce((s, l) => s.plus(l.accrued), new Big(0)).round(0, Big.roundHalfUp),
  );
  const ns = nextStatementDate(asOf, statementDay);

  return {
    statements,
    currentOutstanding: outstanding,
    unbilledInterest: unbilled,
    currentUtilizationPercent: utilization(outstanding, creditLimit),
    revolving,
    totalInterestPaid,
    totalFeesPaid,
    nextStatementDate: toISODate(ns),
    nextDueDate: toISODate(dueDateFor(ns, dueDay)),
  };

  // -------------------------------------------------------------------------

  function isStatementDay(d: Date): boolean {
    return currentStatementDate(d, statementDay).getTime() === d.getTime();
  }

  /**
   * Apply a credit (payment or refund) against open lots.
   * Order: FEE -> INTEREST -> EMI -> CASH_ADVANCE -> RETAIL, oldest first.
   */
  function applyCredit(amount: Paise): void {
    let left = amount;
    const order: LotType[] = ['FEE', 'INTEREST', 'EMI', 'CASH_ADVANCE', 'RETAIL', 'REFUND'];
    for (const type of order) {
      const bucket = lots
        .filter((l) => l.type === type && l.balance > 0)
        .sort((a, b) => a.date.getTime() - b.date.getTime());
      for (const lot of bucket) {
        if (left <= 0) return;
        const applied = Math.min(left, lot.balance);
        lot.balance -= applied;
        left -= applied;
      }
    }
    // Anything left over sits on the card as a credit against future spend.
    if (left > 0) creditBalance += left;
  }

  /**
   * Payments received *after* the statement was cut, up to and including `to`.
   *
   * The lower bound is exclusive: a payment dated on the statement date has
   * already reduced the billed balance in step 2, so counting it again here
   * would settle a statement it had in fact only shrunk.
   */
  function paymentsBetween(from: Date, to: Date): Paise {
    return sumMoney(
      pays
        .filter((p) => {
          const d = toDate(p.date);
          return d.getTime() > from.getTime() && d.getTime() <= to.getTime();
        })
        .map((p) => p.amount),
    );
  }

  /**
   * At the due date we learn whether the interest-free period was earned.
   * Paid in full -> waive provisional interest on grace-eligible lots.
   * Otherwise   -> the interest stands and every open lot loses grace for good.
   */
  function settleDueDate(stmt: ComputedStatement): void {
    const paid = paymentsBetween(toDate(stmt.statementDate), toDate(stmt.dueDate));
    stmt.paidByDueDate = paid;

    // How much of *this statement's* own balance is still outstanding. A
    // merchant refund settles a statement just as surely as a payment does, so
    // we check the remaining balance as well as the payments received.
    const stmtDay = toDate(stmt.statementDate).getTime();
    const statementRemaining =
      sumMoney(lots.filter((l) => l.date.getTime() <= stmtDay).map((l) => l.balance)) - creditBalance;

    // A statement with nothing owed is settled by definition - it must not put
    // the card into revolving just because spend has been posted since.
    stmt.paidInFull =
      stmt.totalAmountDue <= 0 || paid >= stmt.totalAmountDue || statementRemaining <= 0;
    stmt.minimumPaid = stmt.paidInFull || stmt.minimumDue <= 0 || paid >= stmt.minimumDue;

    if (stmt.paidInFull) {
      // Grace earned. Waive the provisional interest on eligible lots that were
      // part of *this* statement. Lots originating after the statement date
      // belong to the next cycle and keep accruing provisionally - their own
      // due date decides whether they are ever billed.
      const statementDay = toDate(stmt.statementDate).getTime();
      for (const lot of lots) {
        if (lot.graceEligible && lot.date.getTime() <= statementDay) lot.accrued = new Big(0);
      }
      revolving = false;
      stmt.revolving = false;
    } else {
      revolving = true;
      stmt.revolving = true;
      // Everything currently open has now lost the interest-free period.
      for (const lot of lots) lot.graceEligible = false;
      if (!stmt.minimumPaid) {
        const fee = lateFeeFor(stmt.totalAmountDue);
        if (fee > 0) {
          stmt.lateFee += fee;
          lots.push({
            id: `lot-${lotSeq++}`,
            date: toDate(stmt.dueDate),
            type: 'FEE',
            balance: fee,
            accrued: new Big(0),
            graceEligible: false,
          });
          cycleCarriedFees += fee;
          totalFeesPaid += fee;
        }
      }
    }

    stmt.status = deriveStatus(stmt, true);
    lots = lots.filter((l) => l.balance !== 0 || !l.accrued.eq(0));
  }

  function generateStatement(statementDate: Date): ComputedStatement {
    const due = dueDateFor(statementDate, dueDay);

    // Bill the interest that is no longer waivable.
    let billable = new Big(0);
    for (const lot of lots) {
      if (lot.accrued.eq(0)) continue;
      if (lot.graceEligible) continue; // still provisional - may yet be waived
      billable = billable.plus(lot.accrued);
      lot.accrued = new Big(0);
    }
    const interest = Number(billable.round(0, Big.roundHalfUp));

    const balanceBeforeCharges = sumMoney(lots.map((l) => l.balance)) - creditBalance;
    const excess = clampZero(balanceBeforeCharges - creditLimit);
    const overlimitFee = overlimitFeeFor(excess);
    // Late fees carried in from the previous due date are billed here, so they
    // attract GST and count as mandatory in the minimum due.
    const feesThisCycle = cycleCashAdvanceFee + overlimitFee + cycleCarriedFees;
    const gst = gstOn(interest + feesThisCycle);

    // Interest, fees and GST all become new interest-bearing lots.
    for (const [type, amount] of [
      ['INTEREST', interest],
      ['FEE', feesThisCycle + gst],
    ] as Array<[LotType, Paise]>) {
      if (amount > 0) {
        lots.push({
          id: `lot-${lotSeq++}`,
          date: statementDate,
          type,
          balance: amount,
          accrued: new Big(0),
          graceEligible: false,
        });
      }
    }
    totalInterestPaid += interest;
    totalFeesPaid += feesThisCycle;

    const totalDue = sumMoney(lots.map((l) => l.balance)) - creditBalance;
    const minimumDue = calculateMinimumDue({
      totalOutstanding: totalDue,
      emiAmount: cycleEmi,
      gst,
      fees: feesThisCycle,
      financeCharges: interest,
      overlimitAmount: excess,
      retailSpends: cycleRetail,
      cashAdvance: cycleCash,
      madPercent,
      variant: madVariant,
    });

    const stmt: ComputedStatement = {
      statementMonth: monthKey(statementDate),
      statementDate: toISODate(statementDate),
      dueDate: toISODate(due),
      previousStatementDate: toISODate(cycleStart),
      openingBalance,
      retailSpends: cycleRetail,
      cashAdvances: cycleCash,
      emiSpends: cycleEmi,
      refunds: cycleRefunds,
      paymentsInCycle: cyclePayments,
      interestCharged: interest,
      lateFee: 0,
      overlimitFee,
      cashAdvanceFee: cycleCashAdvanceFee,
      gst,
      totalAmountDue: totalDue,
      minimumDue,
      paidByDueDate: 0,
      paidInFull: false,
      minimumPaid: false,
      status: 'UNPAID',
      revolving,
      utilizationPercent: utilization(totalDue, creditLimit),
    };

    // Reset cycle accumulators.
    cycleStart = statementDate;
    openingBalance = totalDue;
    cycleRetail = 0;
    cycleCash = 0;
    cycleEmi = 0;
    cycleRefunds = 0;
    cyclePayments = 0;
    cycleCashAdvanceFee = 0;
    cycleCarriedFees = 0;

    return stmt;
  }
}

function deriveStatus(stmt: ComputedStatement, dueDatePassed: boolean): StatementStatus {
  if (stmt.totalAmountDue <= 0) return 'PAID';
  if (stmt.paidInFull) return 'PAID';
  if (dueDatePassed && !stmt.minimumPaid) return 'OVERDUE';
  if (stmt.minimumPaid && stmt.paidByDueDate < stmt.totalAmountDue) {
    return stmt.paidByDueDate > stmt.minimumDue ? 'PARTIAL' : 'MIN_PAID';
  }
  if (stmt.paidByDueDate > 0) return 'PARTIAL';
  return 'UNPAID';
}

/** Utilization as a percentage of the credit limit. */
export function utilization(outstanding: Paise, creditLimit: Paise): number {
  if (creditLimit <= 0) return 0;
  return Number(new Big(clampZero(outstanding)).times(100).div(creditLimit).round(2, Big.roundHalfUp));
}

export type UtilizationBand = 'GOOD' | 'WATCH' | 'HIGH';

/** Under 30% is healthy; above 30% starts hurting your CIBIL score. */
export function utilizationBand(pct: number): UtilizationBand {
  if (pct < 30) return 'GOOD';
  if (pct <= 50) return 'WATCH';
  return 'HIGH';
}

// ---------------------------------------------------------------------------
// Single-cycle convenience wrapper
// ---------------------------------------------------------------------------

export interface StatementInterestInput {
  previousStatementDate: ISODate;
  statementDate: ISODate;
  dueDate: ISODate;
  apr: number;
  creditLimit: Paise;
  /** Transactions from the *previous* cycle that are still unpaid, with their real dates. */
  carriedTransactions?: CardTransaction[];
  transactions: CardTransaction[];
  payments: CardPayment[];
  /** Was the previous statement settled in full by its due date? */
  previousPaidInFull: boolean;
  madPercent?: number;
  madVariant?: 'STANDARD' | 'HDFC';
}

/**
 * Interest for a single statement cycle.
 *
 * Thin wrapper over `runCardLedger` for callers that only have one cycle in
 * hand. When `previousPaidInFull` is false the carried transactions accrue from
 * their own dates, which is the behaviour that surprises people.
 */
export function calculateStatementInterest(input: StatementInterestInput): {
  interest: Paise;
  gst: Paise;
  totalAmountDue: Paise;
  minimumDue: Paise;
  revolving: boolean;
} {
  const statementDay = toDate(input.statementDate).getDate();
  const dueDay = toDate(input.dueDate).getDate();

  const allTxns = [...(input.carriedTransactions ?? []), ...input.transactions];

  // The simulation must begin no later than the oldest transaction it is given.
  // Starting at the previous statement date would silently drop every carried
  // transaction - which is precisely the case this function exists to model.
  const from = allTxns
    .map((t) => t.date)
    .concat(input.previousStatementDate)
    .reduce((earliest, d) => (d < earliest ? d : earliest), input.previousStatementDate);

  const result = runCardLedger({
    statementDay,
    dueDay,
    apr: input.apr,
    creditLimit: input.creditLimit,
    madPercent: input.madPercent,
    madVariant: input.madVariant,
    transactions: allTxns,
    payments: input.payments,
    from,
    // The caller already knows how the previous cycle ended; honour it rather
    // than re-deriving it from whatever payments happen to be in scope.
    initialRevolving: !input.previousPaidInFull,
    // One cycle only: earlier statement days must not bill the interest away.
    emitStatementsFrom: input.statementDate,
    asOf: input.statementDate,
  });

  const last = result.statements[result.statements.length - 1];
  return {
    interest: last?.interestCharged ?? 0,
    gst: last?.gst ?? 0,
    totalAmountDue: last?.totalAmountDue ?? result.currentOutstanding,
    minimumDue: last?.minimumDue ?? 0,
    revolving: result.revolving,
  };
}

/**
 * Interest on a fixed balance held for a number of days - the raw ADB formula.
 * Exposed because it is the number people want to sanity-check by hand.
 */
export function interestForDays(balance: Paise, apr: number, days: number): Paise {
  if (balance <= 0 || days <= 0 || apr <= 0) return 0;
  return Number(
    new Big(balance).times(apr).div(100).times(days).div(365).round(0, Big.roundHalfUp),
  );
}

// ---------------------------------------------------------------------------
// The minimum-due trap
// ---------------------------------------------------------------------------

export interface MinimumPaymentSimulation {
  /** True when the minimum does not even cover the interest - the balance never falls. */
  neverPaysOff: boolean;
  months: number;
  years: number;
  remainingMonths: number;
  totalInterest: Paise;
  totalPaid: Paise;
  /** Month-by-month trace, for the chart. */
  schedule: Array<{
    month: number;
    openingBalance: Paise;
    interest: Paise;
    payment: Paise;
    principalPaid: Paise;
    closingBalance: Paise;
  }>;
}

/**
 * What paying only the minimum actually costs.
 *
 * A Rs 1,00,000 balance at 45% APR takes roughly 8 years and costs well over
 * Rs 1,00,000 in interest. The spec's pseudocode can loop forever when the
 * minimum is smaller than the monthly interest, so that case returns
 * `neverPaysOff` instead of hanging.
 */
export function simulateMinimumPayments(
  balance: Paise,
  apr: number,
  madPercent = 5,
  floor: Paise = 50_000,
): MinimumPaymentSimulation {
  const empty: MinimumPaymentSimulation = {
    neverPaysOff: false,
    months: 0,
    years: 0,
    remainingMonths: 0,
    totalInterest: 0,
    totalPaid: 0,
    schedule: [],
  };
  if (balance <= 0) return empty;

  const monthlyRate = new Big(apr).div(12).div(100);
  const schedule: MinimumPaymentSimulation['schedule'] = [];

  let bal = balance;
  let totalInterest = 0;
  let totalPaid = 0;
  let months = 0;
  const MAX_MONTHS = 1200; // 100 years

  while (bal > 0 && months < MAX_MONTHS) {
    const opening = bal;
    const interest = Number(new Big(opening).times(monthlyRate).round(0, Big.roundHalfUp));
    const withInterest = opening + interest;

    // MAD = max(X% of balance, floor, interest + 1% of principal), capped at the balance.
    let payment = maxMoney(
      pctOf(withInterest, madPercent),
      floor,
      interest + pctOf(opening, 1),
    );
    payment = Math.min(payment, withInterest);

    const principalPaid = payment - interest;
    if (principalPaid <= 0) {
      return { ...empty, neverPaysOff: true, schedule };
    }

    bal = clampZero(withInterest - payment);
    totalInterest += interest;
    totalPaid += payment;
    months += 1;

    schedule.push({
      month: months,
      openingBalance: opening,
      interest,
      payment,
      principalPaid,
      closingBalance: bal,
    });
  }

  return {
    neverPaysOff: bal > 0,
    months,
    years: Math.floor(months / 12),
    remainingMonths: months % 12,
    totalInterest,
    totalPaid,
    schedule,
  };
}

// ---------------------------------------------------------------------------
// Payoff planner: avalanche vs snowball
// ---------------------------------------------------------------------------

export interface PayoffCard {
  id: string;
  name: string;
  balance: Paise;
  apr: number;
  madPercent?: number;
  minimumFloor?: Paise;
}

export type PayoffStrategy = 'AVALANCHE' | 'SNOWBALL';

export interface PayoffResult {
  strategy: PayoffStrategy;
  /** False when the budget cannot even cover every card's minimum. */
  feasible: boolean;
  months: number;
  years: number;
  remainingMonths: number;
  totalInterest: Paise;
  totalPaid: Paise;
  /** Cards in the order they get cleared. */
  payoffOrder: Array<{ cardId: string; name: string; clearedInMonth: number; interestPaid: Paise }>;
  schedule: Array<{
    month: number;
    totalBalance: Paise;
    totalInterest: Paise;
    payments: Array<{ cardId: string; payment: Paise; balance: Paise }>;
  }>;
  /** Minimum monthly budget needed to make any progress at all. */
  minimumBudgetRequired: Paise;
}

/**
 * Simulate clearing a set of cards on a fixed monthly budget.
 *
 * Avalanche targets the highest APR first and always costs the least interest.
 * Snowball targets the smallest balance first and clears cards sooner, which
 * some people need to stay motivated. Both pay every card's minimum first and
 * throw everything spare at the single target card.
 */
export function simulatePayoff(
  cards: PayoffCard[],
  monthlyBudget: Paise,
  strategy: PayoffStrategy,
): PayoffResult {
  const active = cards.filter((c) => c.balance > 0);

  const base: PayoffResult = {
    strategy,
    feasible: true,
    months: 0,
    years: 0,
    remainingMonths: 0,
    totalInterest: 0,
    totalPaid: 0,
    payoffOrder: [],
    schedule: [],
    minimumBudgetRequired: 0,
  };
  if (active.length === 0) return base;

  const state = active.map((c) => ({
    ...c,
    madPercent: c.madPercent ?? 5,
    minimumFloor: c.minimumFloor ?? 50_000,
    interestPaid: 0 as Paise,
  }));

  const minimumBudgetRequired = sumMoney(
    state.map((c) => {
      const interest = Number(new Big(c.balance).times(c.apr).div(1200).round(0, Big.roundHalfUp));
      return Math.min(
        maxMoney(pctOf(c.balance + interest, c.madPercent), c.minimumFloor, interest + pctOf(c.balance, 1)),
        c.balance + interest,
      );
    }),
  );

  if (monthlyBudget < minimumBudgetRequired) {
    return { ...base, feasible: false, minimumBudgetRequired };
  }

  const schedule: PayoffResult['schedule'] = [];
  const payoffOrder: PayoffResult['payoffOrder'] = [];
  let totalInterest = 0;
  let totalPaid = 0;
  let month = 0;
  const MAX_MONTHS = 1200;

  while (state.some((c) => c.balance > 0) && month < MAX_MONTHS) {
    month += 1;
    let budget = monthlyBudget;
    const monthPayments: Array<{ cardId: string; payment: Paise; balance: Paise }> = [];

    // 1. Accrue this month's interest on every card.
    let monthInterest = 0;
    for (const c of state) {
      if (c.balance <= 0) continue;
      const interest = Number(new Big(c.balance).times(c.apr).div(1200).round(0, Big.roundHalfUp));
      c.balance += interest;
      c.interestPaid += interest;
      monthInterest += interest;
    }
    totalInterest += monthInterest;

    // 2. Pay every card its minimum.
    for (const c of state) {
      if (c.balance <= 0 || budget <= 0) continue;
      const interest = Number(new Big(c.balance).times(c.apr).div(1200).round(0, Big.roundHalfUp));
      const mad = Math.min(
        maxMoney(pctOf(c.balance, c.madPercent), c.minimumFloor, interest + pctOf(c.balance, 1)),
        c.balance,
      );
      const pay = Math.min(mad, budget, c.balance);
      c.balance -= pay;
      budget -= pay;
      totalPaid += pay;
      monthPayments.push({ cardId: c.id, payment: pay, balance: c.balance });
    }

    // 3. Everything left goes to the single target card.
    const remaining = state.filter((c) => c.balance > 0);
    if (remaining.length > 0 && budget > 0) {
      const target =
        strategy === 'AVALANCHE'
          ? remaining.reduce((a, b) => (b.apr > a.apr ? b : a))
          : remaining.reduce((a, b) => (b.balance < a.balance ? b : a));

      const extra = Math.min(budget, target.balance);
      target.balance -= extra;
      budget -= extra;
      totalPaid += extra;
      const entry = monthPayments.find((p) => p.cardId === target.id);
      if (entry) {
        entry.payment += extra;
        entry.balance = target.balance;
      } else {
        monthPayments.push({ cardId: target.id, payment: extra, balance: target.balance });
      }
    }

    // 4. Record any card cleared this month.
    for (const c of state) {
      if (c.balance <= 0 && !payoffOrder.some((p) => p.cardId === c.id)) {
        payoffOrder.push({
          cardId: c.id,
          name: c.name,
          clearedInMonth: month,
          interestPaid: c.interestPaid,
        });
      }
    }

    schedule.push({
      month,
      totalBalance: sumMoney(state.map((c) => clampZero(c.balance))),
      totalInterest: monthInterest,
      payments: monthPayments,
    });
  }

  return {
    strategy,
    feasible: state.every((c) => c.balance <= 0),
    months: month,
    years: Math.floor(month / 12),
    remainingMonths: month % 12,
    totalInterest,
    totalPaid,
    payoffOrder,
    schedule,
    minimumBudgetRequired,
  };
}

/** Run both strategies so the UI can show them side by side. */
export function comparePayoffStrategies(
  cards: PayoffCard[],
  monthlyBudget: Paise,
): { avalanche: PayoffResult; snowball: PayoffResult; interestSaved: Paise; monthsSaved: number } {
  const avalanche = simulatePayoff(cards, monthlyBudget, 'AVALANCHE');
  const snowball = simulatePayoff(cards, monthlyBudget, 'SNOWBALL');
  return {
    avalanche,
    snowball,
    interestSaved: clampZero(snowball.totalInterest - avalanche.totalInterest),
    monthsSaved: Math.max(0, snowball.months - avalanche.months),
  };
}
