/**
 * Card state resolution.
 *
 * The app lets you describe a card two ways — typed statement totals, or logged
 * transactions. These tests pin down which one wins and make sure the answer is
 * single-valued, because the one thing worse than a wrong balance is two
 * different balances on the same screen.
 */
import { describe, expect, it } from 'vitest';
import { resolveAllCardStates, resolveCardState } from '@/lib/finance/cardState';
import { toPaise } from '@/lib/finance/money';
import type {
  CardPaymentRecord,
  CardTxnRecord,
  CreditCard,
  CreditCardStatement,
} from '@/types';

const STAMP = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const ASOF = new Date('2026-06-10T00:00:00');

function card(over: Partial<CreditCard> = {}): CreditCard {
  return {
    id: 'c1', userId: 'u', cardName: 'Millennia', issuer: 'HDFC Bank', last4: '4821',
    creditLimit: toPaise(2_00_000), statementDay: 18, dueDay: 8, apr: 43.2,
    madPercent: 5, madVariant: 'STANDARD', isActive: true, ...STAMP, ...over,
  };
}

function statement(over: Partial<CreditCardStatement> = {}): CreditCardStatement {
  return {
    id: 's1', cardId: 'c1', statementMonth: '2026-05', statementDate: '2026-05-18',
    dueDate: '2026-06-08', previousStatementDate: '2026-04-18', openingBalance: 0,
    totalAmountDue: toPaise(20_000), minimumDue: toPaise(1_000), transactions: [], payments: [],
    totalPaid: toPaise(5_000), minimumPaid: true, interestCharged: toPaise(400), lateFee: 0,
    overlimitFee: 0, cashAdvanceFee: 0, gst: toPaise(72), status: 'PARTIAL', revolving: true,
    ...STAMP, ...over,
  };
}

function txn(over: Partial<CardTxnRecord> = {}): CardTxnRecord {
  return { id: 't1', cardId: 'c1', date: '2026-04-10', amount: toPaise(15_000), type: 'RETAIL', ...STAMP, ...over };
}

function payment(over: Partial<CardPaymentRecord> = {}): CardPaymentRecord {
  return { id: 'p1', cardId: 'c1', date: '2026-05-12', amount: toPaise(2_000), ...STAMP, ...over };
}

describe('with nothing logged', () => {
  const state = resolveCardState({ card: card(), statements: [], txns: [], payments: [], asOf: ASOF });

  it('reports a clean card', () => {
    expect(state.source).toBe('NONE');
    expect(state.outstanding).toBe(0);
    expect(state.minimumDue).toBe(0);
    expect(state.utilizationPercent).toBe(0);
    expect(state.revolving).toBe(false);
  });

  it('still projects the next due date, so the dashboard has something to show', () => {
    expect(state.dueDate).toBe('2026-07-08'); // statement 18 Jun -> due 8 Jul
  });
});

describe('with statements only', () => {
  const state = resolveCardState({
    card: card(), statements: [statement()], txns: [], payments: [], asOf: ASOF,
  });

  it('uses the entered figures', () => {
    expect(state.source).toBe('STATEMENT');
    expect(state.outstanding).toBe(toPaise(15_000)); // 20,000 due less 5,000 paid
    expect(state.minimumDue).toBe(toPaise(1_000));
    expect(state.dueDate).toBe('2026-06-08');
  });

  it('derives utilization from the entered balance', () => {
    expect(state.utilizationPercent).toBe(7.5); // 15,000 of 2,00,000
  });

  it('asks for nothing once the statement is paid', () => {
    const paid = resolveCardState({
      card: card(),
      statements: [statement({ status: 'PAID', totalPaid: toPaise(20_000) })],
      txns: [], payments: [], asOf: ASOF,
    });
    expect(paid.outstanding).toBe(0);
    expect(paid.minimumDue).toBe(0);
  });

  it('uses the most recent statement when there are several', () => {
    const state2 = resolveCardState({
      card: card(),
      statements: [
        statement({ id: 'old', statementDate: '2026-04-18', totalAmountDue: toPaise(99_000), totalPaid: 0 }),
        statement({ id: 'new', statementDate: '2026-05-18', totalAmountDue: toPaise(20_000), totalPaid: toPaise(5_000) }),
      ],
      txns: [], payments: [], asOf: ASOF,
    });
    expect(state2.outstanding).toBe(toPaise(15_000));
  });
});

describe('with a transaction ledger', () => {
  const state = resolveCardState({
    card: card(),
    // Statements are present too — the ledger must win.
    statements: [statement({ totalAmountDue: toPaise(99_999), totalPaid: 0 })],
    txns: [txn()],
    payments: [payment()],
    asOf: ASOF,
  });

  it('prefers the ledger over entered statements', () => {
    expect(state.source).toBe('LEDGER');
    // Rs 15,000 spent, Rs 2,000 paid, plus interest and fees — nowhere near the
    // Rs 99,999 the stale statement claims.
    expect(state.outstanding).toBeLessThan(toPaise(30_000));
    expect(state.outstanding).toBeGreaterThan(toPaise(13_000));
  });

  it('knows the card is revolving', () => {
    expect(state.revolving).toBe(true);
  });

  it('surfaces interest and fees charged to date', () => {
    expect(state.totalInterestCharged).toBeGreaterThan(0);
    expect(state.totalFeesCharged).toBeGreaterThan(0); // a late fee was earned
  });

  it('reports interest accrued but not yet billed', () => {
    expect(state.unbilledInterest).toBeGreaterThanOrEqual(0);
  });

  it('switches to the ledger as soon as a single payment exists', () => {
    const justAPayment = resolveCardState({
      card: card(), statements: [statement()], txns: [], payments: [payment()], asOf: ASOF,
    });
    expect(justAPayment.source).toBe('LEDGER');
  });
});

describe('a cleared ledger', () => {
  it('owes nothing and keeps its grace period', () => {
    const state = resolveCardState({
      card: card(),
      statements: [],
      txns: [txn({ date: '2026-05-02', amount: toPaise(10_000) })],
      // Paid in full before the due date.
      payments: [payment({ date: '2026-06-01', amount: toPaise(10_000) })],
      asOf: ASOF,
    });
    expect(state.outstanding).toBe(0);
    expect(state.revolving).toBe(false);
    expect(state.totalInterestCharged).toBe(0);
    expect(state.minimumDue).toBe(0);
  });
});

describe('resolveAllCardStates', () => {
  const cards = [card({ id: 'c1' }), card({ id: 'c2', issuer: 'SBI Card', statementDay: 5, dueDay: 25 })];

  it('resolves each card independently, from its own data', () => {
    const states = resolveAllCardStates({
      cards,
      statements: [statement({ cardId: 'c2' })],
      txns: [txn({ cardId: 'c1' })],
      payments: [],
      asOf: ASOF,
    });
    expect(states).toHaveLength(2);
    expect(states.find((s) => s.card.id === 'c1')?.source).toBe('LEDGER');
    expect(states.find((s) => s.card.id === 'c2')?.source).toBe('STATEMENT');
  });

  it('never leaks one card data into another', () => {
    const states = resolveAllCardStates({
      cards,
      statements: [],
      txns: [txn({ cardId: 'c1', amount: toPaise(50_000) })],
      payments: [],
      asOf: ASOF,
    });
    expect(states.find((s) => s.card.id === 'c2')?.outstanding).toBe(0);
    expect(states.find((s) => s.card.id === 'c1')?.outstanding).toBeGreaterThan(0);
  });

  it('skips inactive cards', () => {
    const states = resolveAllCardStates({
      cards: [card({ id: 'c1', isActive: false }), card({ id: 'c2' })],
      statements: [], txns: [], payments: [], asOf: ASOF,
    });
    expect(states).toHaveLength(1);
    expect(states[0].card.id).toBe('c2');
  });

  it('is deterministic — the same inputs give the same answer', () => {
    const args = { cards, statements: [statement({ cardId: 'c2' })], txns: [txn({ cardId: 'c1' })], payments: [], asOf: ASOF };
    const a = resolveAllCardStates(args);
    const b = resolveAllCardStates(args);
    expect(a.map((s) => s.outstanding)).toEqual(b.map((s) => s.outstanding));
  });
});
