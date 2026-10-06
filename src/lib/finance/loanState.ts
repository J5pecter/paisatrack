/**
 * What is actually outstanding on a loan?
 *
 * Mirrors cardState.ts: one resolver, so the loan page, the dashboard and the
 * debt total cannot disagree. `loan.outstandingPrincipal` is a figure the user
 * typed once and which drifts the moment an EMI is paid, so it is only ever the
 * fallback — recorded payments win, and failing that the schedule is read at
 * today's date.
 */
import type { ISODate, Loan, LoanPayment, Paise } from '@/types';
import {
  generateAmortization,
  type AmortizationRow,
  type AmortizationSummary,
  type PrepaymentInput,
} from './emi';
import { todayISO } from './dates';
import { clampZero, percentage, sumMoney } from './money';

export type LoanStateSource = 'PAYMENTS' | 'SCHEDULE';

export interface LoanState {
  loan: Loan;
  /** Where the outstanding figure came from. */
  source: LoanStateSource;
  schedule: AmortizationSummary;
  /** Instalments actually recorded as paid. */
  paidInstallments: number;
  outstandingPrincipal: Paise;
  principalRepaid: Paise;
  repaidPercent: number;
  totalPaid: Paise;
  interestPaidToDate: Paise;
  prepaymentsTotal: Paise;
  /** The next instalment falling due, if the loan is still running. */
  nextDue?: AmortizationRow;
  isClosed: boolean;
}

export interface ResolveLoanStateInput {
  loan: Loan;
  payments: LoanPayment[];
  asOf?: ISODate;
}

export function resolveLoanState(input: ResolveLoanStateInput): LoanState {
  const { loan } = input;
  const asOf = input.asOf ?? todayISO();

  const mine = input.payments
    .filter((p) => p.loanId === loan.id)
    .sort((a, b) => a.paidOn.localeCompare(b.paidOn));

  const prepayments: PrepaymentInput[] = mine
    .filter((p) => p.isPrepayment && p.amount > 0)
    .map((p) => ({
      afterInstallment: Math.max(1, p.installmentNumber ?? 1),
      amount: p.amount,
      mode: p.prepaymentMode ?? 'REDUCE_TENURE',
    }));

  const schedule = generateAmortization({
    principal: loan.principalAmount,
    annualRatePercent: loan.interestRate,
    tenureMonths: loan.tenureMonths,
    startDate: loan.startDate,
    emiDay: loan.emiDay,
    emiAmount: loan.emiAmount,
    prepayments,
  });

  const regular = mine.filter((p) => !p.isPrepayment);
  const prepaymentsTotal = sumMoney(mine.filter((p) => p.isPrepayment).map((p) => p.amount));

  // --- Outstanding ----------------------------------------------------------
  let paidInstallments: number;
  let outstandingPrincipal: Paise;
  let source: LoanStateSource;

  if (regular.length > 0) {
    // Recorded payments are authoritative. The highest instalment number
    // actually recorded is where the loan stands.
    paidInstallments = regular.reduce(
      (max, p) => Math.max(max, p.installmentNumber ?? 0),
      0,
    );
    const row = schedule.rows[paidInstallments - 1];
    outstandingPrincipal = row ? row.closingBalance : loan.principalAmount;
    source = 'PAYMENTS';
  } else {
    // Nothing recorded: read the schedule at today's date, which is what a
    // borrower paying by standing instruction would expect to see.
    //
    // `loan.outstandingPrincipal` is deliberately not consulted even here. It
    // is a figure typed once that goes stale the moment an EMI is paid, and
    // falling back to it would reintroduce exactly the drift this resolver
    // exists to remove. Before the first instalment, the answer is simply the
    // full principal.
    paidInstallments = schedule.rows.filter((r) => r.dueDate <= asOf).length;
    const row = schedule.rows[paidInstallments - 1];
    outstandingPrincipal = row ? row.closingBalance : loan.principalAmount;
    source = 'SCHEDULE';
  }

  const principalRepaid = clampZero(loan.principalAmount - outstandingPrincipal);
  const interestPaidToDate = sumMoney(
    schedule.rows.slice(0, paidInstallments).map((r) => r.interestComponent),
  );

  return {
    loan,
    source,
    schedule,
    paidInstallments,
    outstandingPrincipal,
    principalRepaid,
    repaidPercent: percentage(principalRepaid, loan.principalAmount),
    totalPaid: sumMoney(regular.map((p) => p.amount)) + prepaymentsTotal,
    interestPaidToDate,
    prepaymentsTotal,
    nextDue: schedule.rows[paidInstallments],
    isClosed: outstandingPrincipal <= 0,
  };
}

export function resolveAllLoanStates(input: {
  loans: Loan[];
  payments: LoanPayment[];
  asOf?: ISODate;
}): LoanState[] {
  return input.loans
    .filter((l) => l.isActive)
    .map((loan) => resolveLoanState({ loan, payments: input.payments, asOf: input.asOf }));
}

/** Has this specific instalment been recorded as paid? */
export function isInstallmentPaid(
  payments: LoanPayment[],
  loanId: string,
  installmentNumber: number,
): boolean {
  return payments.some(
    (p) => p.loanId === loanId && !p.isPrepayment && p.installmentNumber === installmentNumber,
  );
}
