/**
 * Loan state resolution.
 *
 * `loan.outstandingPrincipal` is a figure the user types once and which drifts
 * the moment an EMI is paid. These tests pin down that recorded payments win,
 * and that the schedule position is a sane fallback when nothing is recorded.
 */
import { describe, expect, it } from 'vitest';
import {
  isInstallmentPaid,
  resolveAllLoanStates,
  resolveLoanState,
} from '@/lib/finance/loanState';
import { calculateEMI } from '@/lib/finance/emi';
import { toPaise } from '@/lib/finance/money';
import type { Loan, LoanPayment } from '@/types';

const STAMP = {
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
};

const PRINCIPAL = toPaise(3_50_000);
const RATE = 10.49;
const TENURE = 48;

function loan(over: Partial<Loan> = {}): Loan {
  return {
    id: 'l1', userId: 'u', loanName: 'Personal', lender: 'IDFC', type: 'PERSONAL',
    principalAmount: PRINCIPAL, interestRate: RATE, tenureMonths: TENURE,
    emiAmount: calculateEMI(PRINCIPAL, RATE, TENURE),
    startDate: '2025-04-01', emiDay: 5,
    // Deliberately stale: the resolver must not trust this once payments exist.
    outstandingPrincipal: toPaise(9_99_999),
    isActive: true, ...STAMP, ...over,
  };
}

function payment(n: number, over: Partial<LoanPayment> = {}): LoanPayment {
  return {
    id: `p${n}`, loanId: 'l1', paidOn: '2025-05-05', amount: toPaise(8_959),
    principalComponent: toPaise(6_000), interestComponent: toPaise(2_959),
    isPrepayment: false, installmentNumber: n, ...STAMP, ...over,
  };
}

describe('with nothing recorded', () => {
  it('reads the schedule at today’s date', () => {
    const s = resolveLoanState({ loan: loan(), payments: [], asOf: '2026-06-10' });
    expect(s.source).toBe('SCHEDULE');
    // Disbursed 1-Apr with an EMI day of the 5th, so the first instalment falls
    // on 2025-04-05 and fifteen have passed by 10-Jun-2026.
    expect(s.schedule.rows[0].dueDate).toBe('2025-04-05');
    expect(s.paidInstallments).toBe(15);
    expect(s.outstandingPrincipal).toBe(s.schedule.rows[14].closingBalance);
  });

  it('shows the full principal outstanding before any instalment falls due', () => {
    const s = resolveLoanState({ loan: loan(), payments: [], asOf: '2025-04-01' });
    expect(s.paidInstallments).toBe(0);
    expect(s.outstandingPrincipal).toBe(PRINCIPAL);
    expect(s.repaidPercent).toBe(0);
  });

  it('points at the next instalment due', () => {
    const s = resolveLoanState({ loan: loan(), payments: [], asOf: '2026-06-10' });
    expect(s.nextDue?.installmentNumber).toBe(16);
    expect(s.nextDue?.dueDate).toBe('2026-07-05');
  });
});

describe('with recorded payments', () => {
  const payments = [payment(1), payment(2), payment(3)];
  const s = resolveLoanState({ loan: loan(), payments, asOf: '2026-06-10' });

  it('trusts the payments over the stale stored figure', () => {
    expect(s.source).toBe('PAYMENTS');
    expect(s.paidInstallments).toBe(3);
    expect(s.outstandingPrincipal).toBe(s.schedule.rows[2].closingBalance);
    // Emphatically not the Rs 9,99,999 sitting on the record.
    expect(s.outstandingPrincipal).toBeLessThan(PRINCIPAL);
  });

  it('reports principal repaid and the percentage', () => {
    expect(s.principalRepaid).toBe(PRINCIPAL - s.outstandingPrincipal);
    expect(s.repaidPercent).toBeGreaterThan(0);
    expect(s.repaidPercent).toBeLessThan(10); // only three of forty-eight
  });

  it('adds up the interest paid so far', () => {
    const expected =
      s.schedule.rows[0].interestComponent +
      s.schedule.rows[1].interestComponent +
      s.schedule.rows[2].interestComponent;
    expect(s.interestPaidToDate).toBe(expected);
  });

  it('is unaffected by the order payments were recorded in', () => {
    const shuffled = resolveLoanState({
      loan: loan(),
      payments: [payment(3), payment(1), payment(2)],
      asOf: '2026-06-10',
    });
    expect(shuffled.outstandingPrincipal).toBe(s.outstandingPrincipal);
    expect(shuffled.paidInstallments).toBe(3);
  });

  it('ignores payments belonging to another loan', () => {
    const s2 = resolveLoanState({
      loan: loan(),
      payments: [payment(1), payment(9, { loanId: 'other' })],
      asOf: '2026-06-10',
    });
    expect(s2.paidInstallments).toBe(1);
  });
});

describe('prepayments', () => {
  it('shorten the schedule and reduce the outstanding', () => {
    const withoutPre = resolveLoanState({ loan: loan(), payments: [payment(1)], asOf: '2026-06-10' });
    const withPre = resolveLoanState({
      loan: loan(),
      payments: [
        payment(1),
        {
          ...payment(99),
          id: 'pre1',
          isPrepayment: true,
          amount: toPaise(1_00_000),
          installmentNumber: 1,
          prepaymentMode: 'REDUCE_TENURE',
        },
      ],
      asOf: '2026-06-10',
    });

    expect(withPre.schedule.months).toBeLessThan(withoutPre.schedule.months);
    expect(withPre.outstandingPrincipal).toBeLessThan(withoutPre.outstandingPrincipal);
    expect(withPre.prepaymentsTotal).toBe(toPaise(1_00_000));
  });
});

describe('a fully repaid loan', () => {
  it('reports itself closed', () => {
    const payments = Array.from({ length: TENURE }, (_, i) => payment(i + 1));
    const s = resolveLoanState({ loan: loan(), payments, asOf: '2029-06-10' });
    expect(s.paidInstallments).toBe(TENURE);
    expect(s.outstandingPrincipal).toBe(0);
    expect(s.isClosed).toBe(true);
    expect(s.repaidPercent).toBe(100);
    expect(s.nextDue).toBeUndefined();
  });
});

describe('isInstallmentPaid', () => {
  const payments = [payment(1), payment(2)];

  it('knows which instalments are recorded', () => {
    expect(isInstallmentPaid(payments, 'l1', 1)).toBe(true);
    expect(isInstallmentPaid(payments, 'l1', 3)).toBe(false);
  });

  it('does not count a prepayment as an instalment', () => {
    const withPre = [...payments, { ...payment(3), isPrepayment: true }];
    expect(isInstallmentPaid(withPre, 'l1', 3)).toBe(false);
  });

  it('is scoped to the loan', () => {
    expect(isInstallmentPaid(payments, 'other-loan', 1)).toBe(false);
  });
});

describe('resolveAllLoanStates', () => {
  it('resolves each active loan and skips closed ones', () => {
    const states = resolveAllLoanStates({
      loans: [loan({ id: 'l1' }), loan({ id: 'l2', isActive: false })],
      payments: [],
      asOf: '2026-06-10',
    });
    expect(states).toHaveLength(1);
    expect(states[0].loan.id).toBe('l1');
  });
});
