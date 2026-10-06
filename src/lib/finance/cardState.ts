/**
 * What does this card actually owe?
 *
 * There are two ways to tell PaisaTrack about a card, and they must never
 * disagree on screen:
 *
 *   1. Type the totals off your statement. Simple, and what most people want.
 *   2. Log individual transactions and payments, and let the engine compute the
 *      statements — including interest dated from each transaction.
 *
 * This module resolves the two into one answer. The ledger wins when it has
 * anything to work with, because it is strictly more informed: it knows the
 * transaction dates, the accrued-but-unbilled interest, and whether the card is
 * revolving. Statements are the fallback.
 */
import type {
  CardPaymentRecord,
  CardTxnRecord,
  CreditCard,
  CreditCardStatement,
  ISODate,
  Paise,
} from '@/types';
import { runCardLedger, utilization } from './creditCard';
import { dueDateFor, nextStatementDate, toISODate } from './dates';
import { clampZero } from './money';

export type CardStateSource = 'LEDGER' | 'STATEMENT' | 'NONE';

export interface CardState {
  card: CreditCard;
  /** Where these numbers came from, so the UI can say so. */
  source: CardStateSource;
  outstanding: Paise;
  minimumDue: Paise;
  dueDate: ISODate;
  utilizationPercent: number;
  revolving: boolean;
  /** Interest accrued since the last statement, not yet billed. Ledger only. */
  unbilledInterest: Paise;
  /** Interest and fees charged across the whole history. Ledger only. */
  totalInterestCharged: Paise;
  totalFeesCharged: Paise;
  statementId?: string;
}

export interface ResolveCardStateInput {
  card: CreditCard;
  statements: CreditCardStatement[];
  txns: CardTxnRecord[];
  payments: CardPaymentRecord[];
  asOf?: Date;
}

export function resolveCardState(input: ResolveCardStateInput): CardState {
  const { card, statements, txns, payments } = input;
  const asOf = input.asOf ?? new Date();

  const mine = (arr: Array<{ cardId: string }>) => arr.filter((x) => x.cardId === card.id);
  const cardTxns = mine(txns) as CardTxnRecord[];
  const cardPays = mine(payments) as CardPaymentRecord[];
  const cardStatements = (statements.filter((s) => s.cardId === card.id) as CreditCardStatement[])
    .sort((a, b) => b.statementDate.localeCompare(a.statementDate));

  // --- 1. Ledger, when there is anything to compute from --------------------
  if (cardTxns.length > 0 || cardPays.length > 0) {
    const ledger = runCardLedger({
      statementDay: card.statementDay,
      dueDay: card.dueDay,
      apr: card.apr,
      creditLimit: card.creditLimit,
      madPercent: card.madPercent,
      madVariant: card.madVariant,
      transactions: cardTxns.map((t) => ({
        id: t.id,
        date: t.date,
        amount: t.amount,
        type: t.type,
        ...(t.description ? { description: t.description } : {}),
      })),
      payments: cardPays.map((p) => ({ id: p.id, date: p.date, amount: p.amount })),
      asOf: toISODate(asOf),
    });

    const latest = ledger.statements[ledger.statements.length - 1];

    return {
      card,
      source: 'LEDGER',
      outstanding: clampZero(ledger.currentOutstanding),
      minimumDue: latest && !latest.paidInFull ? latest.minimumDue : 0,
      dueDate: latest && !latest.paidInFull ? latest.dueDate : ledger.nextDueDate,
      utilizationPercent: ledger.currentUtilizationPercent,
      revolving: ledger.revolving,
      unbilledInterest: ledger.unbilledInterest,
      totalInterestCharged: ledger.totalInterestPaid,
      totalFeesCharged: ledger.totalFeesPaid,
    };
  }

  // --- 2. Manually entered statements ---------------------------------------
  const latest = cardStatements[0];
  if (latest) {
    const outstanding = clampZero(latest.totalAmountDue - latest.totalPaid);
    return {
      card,
      source: 'STATEMENT',
      outstanding,
      minimumDue: latest.status === 'PAID' ? 0 : latest.minimumDue,
      dueDate: latest.dueDate,
      utilizationPercent: utilization(outstanding, card.creditLimit),
      revolving: latest.revolving,
      unbilledInterest: 0,
      totalInterestCharged: cardStatements.reduce((s, x) => s + x.interestCharged, 0),
      totalFeesCharged: cardStatements.reduce(
        (s, x) => s + x.lateFee + x.overlimitFee + x.cashAdvanceFee,
        0,
      ),
      statementId: latest.id,
    };
  }

  // --- 3. Nothing logged at all ---------------------------------------------
  const nextStmt = nextStatementDate(asOf, card.statementDay);
  return {
    card,
    source: 'NONE',
    outstanding: 0,
    minimumDue: 0,
    dueDate: toISODate(dueDateFor(nextStmt, card.dueDay)),
    utilizationPercent: 0,
    revolving: false,
    unbilledInterest: 0,
    totalInterestCharged: 0,
    totalFeesCharged: 0,
  };
}

/** Resolve every card at once. */
export function resolveAllCardStates(input: {
  cards: CreditCard[];
  statements: CreditCardStatement[];
  txns: CardTxnRecord[];
  payments: CardPaymentRecord[];
  asOf?: Date;
}): CardState[] {
  return input.cards
    .filter((c) => c.isActive)
    .map((card) => resolveCardState({ ...input, card }));
}
