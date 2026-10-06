/**
 * Cash and bank accounts.
 *
 * Pure functions over plain data, like everything else in `lib/finance`.
 *
 * The model is deliberately one-directional. PaisaTrack stores income as a
 * recurring *definition* — amount, frequency, credited-on day — not as discrete
 * credit transactions, so it genuinely cannot know what landed in an account on
 * any given day. Pretending otherwise would produce a confident wrong number,
 * which is worse than an honest incomplete one.
 *
 * So: you confirm a balance, spending you have tagged to that account is
 * subtracted from it, and when you next count the real thing the difference is
 * reported as unaccounted. That difference is the number worth having. Cash
 * leaks, and the leak is precisely what nothing else shows you.
 */
import { daysBetween } from './dates';
import { clampZero, subMoney, sumMoney, toRupees } from './money';
import type { CashAccount, Expense, ISODate, Paise } from '@/types';

/**
 * Payment methods that actually move money out of a cash or bank account.
 *
 * CREDIT_CARD is excluded on purpose: a card spend does not leave the bank
 * until the bill is paid, and that payment is recorded as its own expense.
 * Counting both would subtract the same rupee twice.
 */
const DRAWS_ON_ACCOUNT = new Set(['CASH', 'UPI', 'DEBIT_CARD', 'NET_BANKING', 'WALLET', 'AUTO_DEBIT']);

export interface AccountProjection {
  accountId: string;
  name: string;
  kind: CashAccount['kind'];
  /** What the user last confirmed was actually there. */
  recorded: Paise;
  recordedAsOf: ISODate;
  /** Tagged spending between `recordedAsOf` (exclusive) and the as-of date. */
  spentSince: Paise;
  /** recorded − spentSince. May be negative; see below. */
  expected: Paise;
  /** How long since the balance was last confirmed against reality. */
  staleDays: number;
  includeInNetWorth: boolean;
}

/**
 * What should be in this account right now, given what was confirmed and what
 * has been spent from it since.
 *
 * `balanceAsOf` is treated as end-of-day: if you counted your wallet on the
 * 5th, spending dated the 5th is already reflected in what you counted.
 *
 * The result is allowed to go negative. An overspent wallet means either the
 * confirmed balance was wrong or something is untracked — clamping that to zero
 * would hide the only signal the number carries.
 */
export function projectAccount(
  account: CashAccount,
  expenses: Expense[],
  asOf: ISODate,
): AccountProjection {
  const spentSince = sumMoney(
    expenses
      .filter((e) => !e.deletedAt)
      .filter((e) => e.cashAccountId === account.id)
      .filter((e) => DRAWS_ON_ACCOUNT.has(e.paymentMethod))
      // String comparison is correct and cheap here: ISO-8601 dates sort
      // lexicographically, and both sides are already YYYY-MM-DD.
      .filter((e) => e.date > account.balanceAsOf && e.date <= asOf)
      .map((e) => e.amount),
  );

  return {
    accountId: account.id,
    name: account.name,
    kind: account.kind,
    recorded: account.balance,
    recordedAsOf: account.balanceAsOf,
    spentSince,
    expected: subMoney(account.balance, spentSince),
    staleDays: Math.max(0, daysBetween(account.balanceAsOf, asOf)),
    includeInNetWorth: account.includeInNetWorth,
  };
}

export interface Reconciliation {
  /** counted − expected. Negative means less is there than there should be. */
  drift: Paise;
  matches: boolean;
  direction: 'MATCH' | 'SHORT' | 'OVER';
}

/**
 * Compare a fresh count against what was expected.
 *
 * SHORT is the common case and usually means spending that never got recorded.
 * OVER usually means income that was not logged — a refund, a transfer in, cash
 * from someone settling up.
 */
export function reconcile(projection: AccountProjection, counted: Paise): Reconciliation {
  const drift = subMoney(counted, projection.expected);
  return {
    drift,
    matches: drift === 0,
    direction: drift === 0 ? 'MATCH' : drift < 0 ? 'SHORT' : 'OVER',
  };
}

/** Every live account that counts towards net worth, added up. */
export function totalLiquid(accounts: CashAccount[]): Paise {
  return sumMoney(
    accounts.filter((a) => !a.deletedAt && a.includeInNetWorth).map((a) => a.balance),
  );
}

/**
 * How many months the liquid cash covers at the current rate of outgoings.
 *
 * Returns `null` rather than `Infinity` when nothing is going out — "Infinity
 * months" is not a sentence anyone needs to read, and the caller can say
 * something sensible instead.
 */
export function runwayMonths(liquid: Paise, monthlyOutgoings: Paise): number | null {
  if (monthlyOutgoings <= 0) return null;
  return toRupees(clampZero(liquid)) / toRupees(monthlyOutgoings);
}

export interface CashSummary {
  cash: Paise;
  bank: Paise;
  /** cash + bank. The parts always sum to this exactly. */
  total: Paise;
  accounts: AccountProjection[];
}

/**
 * The whole liquid picture in one pass.
 *
 * Split by kind so the dashboard can say "₹2,000 in hand, ₹58,000 in the bank"
 * — which is a materially different situation from the same total held one way.
 */
export function summariseAccounts(
  accounts: CashAccount[],
  expenses: Expense[],
  asOf: ISODate,
): CashSummary {
  const live = accounts.filter((a) => !a.deletedAt);
  const counted = live.filter((a) => a.includeInNetWorth);

  const cash = sumMoney(counted.filter((a) => a.kind === 'CASH').map((a) => a.balance));
  const bank = sumMoney(counted.filter((a) => a.kind === 'BANK').map((a) => a.balance));

  return {
    cash,
    bank,
    // Deliberately cash + bank rather than a third independent sum, so the
    // headline can never disagree with the two figures printed beside it.
    total: cash + bank,
    accounts: live.map((a) => projectAccount(a, expenses, asOf)),
  };
}
