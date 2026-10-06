/**
 * Loan EMI and amortization.
 *
 *   E = P * r * (1+r)^n / ((1+r)^n - 1)      where r = annualRate/12/100
 *
 * Amortization rows are generated so that the final closing balance is exactly
 * zero: the last instalment absorbs the accumulated rounding (which is also what
 * every bank does).
 */
import Big from 'big.js';
import type { ISODate, Paise } from '@/types';
import { addMonthsClamped, dayOfMonthClamped, toDate, toISODate } from './dates';
import { clampZero, mulMoney, sumMoney } from './money';

export interface AmortizationRow {
  installmentNumber: number;
  dueDate: ISODate;
  openingBalance: Paise;
  emi: Paise;
  interestComponent: Paise;
  principalComponent: Paise;
  closingBalance: Paise;
  /** Extra principal paid this month on top of the EMI. */
  prepayment?: Paise;
}

export interface AmortizationSummary {
  rows: AmortizationRow[];
  totalInterest: Paise;
  totalPrincipal: Paise;
  totalPaid: Paise;
  months: number;
  /** Date the loan closes. */
  lastPaymentDate: ISODate;
}

/** Monthly rate as a Big, e.g. 8.5% p.a. -> 0.00708333... */
function monthlyRate(annualRatePercent: number): Big {
  return new Big(annualRatePercent).div(12).div(100);
}

/**
 * Standard EMI. Returns paise, rounded to the nearest rupee the way lenders
 * quote it is *not* done here - we keep paise precision and let the UI round.
 *
 * A zero interest rate degenerates to principal / tenure.
 */
export function calculateEMI(principal: Paise, annualRatePercent: number, tenureMonths: number): Paise {
  if (tenureMonths <= 0) throw new Error('calculateEMI: tenureMonths must be > 0');
  if (principal <= 0) return 0;

  if (annualRatePercent === 0) {
    return Number(new Big(principal).div(tenureMonths).round(0, Big.roundHalfUp));
  }

  const r = monthlyRate(annualRatePercent);
  const onePlusRPowN = r.plus(1).pow(tenureMonths);
  const emi = new Big(principal).times(r).times(onePlusRPowN).div(onePlusRPowN.minus(1));
  return Number(emi.round(0, Big.roundHalfUp));
}

/** Total interest paid over the full tenure, assuming no prepayment. */
export function totalInterestOnLoan(
  principal: Paise,
  annualRatePercent: number,
  tenureMonths: number,
): Paise {
  const emi = calculateEMI(principal, annualRatePercent, tenureMonths);
  return clampZero(emi * tenureMonths - principal);
}

/**
 * Solve for the tenure that a given EMI implies.
 *   n = -ln(1 - P*r/E) / ln(1+r)
 * Returns null when the EMI does not even cover the monthly interest.
 */
export function tenureForEMI(principal: Paise, annualRatePercent: number, emi: Paise): number | null {
  if (emi <= 0) return null;
  if (annualRatePercent === 0) return Math.ceil(principal / emi);

  const r = Number(monthlyRate(annualRatePercent));
  const monthlyInterest = principal * r;
  if (emi <= monthlyInterest) return null; // never amortises

  const n = -Math.log(1 - (principal * r) / emi) / Math.log(1 + r);

  // The EMI we were handed is itself rounded to the paise, so the exact inverse
  // lands a hair either side of the true tenure. Snap to the nearest whole month
  // when we are that close; otherwise a genuine partial month rounds up.
  const nearest = Math.round(n);
  if (nearest > 0 && Math.abs(n - nearest) < 0.01) return nearest;
  return Math.ceil(n);
}

export interface PrepaymentInput {
  /** 1-based instalment number *after* which the lump sum is paid. */
  afterInstallment: number;
  amount: Paise;
  /** REDUCE_TENURE keeps the EMI and finishes sooner (usually the better deal). */
  mode: 'REDUCE_TENURE' | 'REDUCE_EMI';
}

export interface AmortizationInput {
  principal: Paise;
  annualRatePercent: number;
  tenureMonths: number;
  startDate: ISODate;
  emiDay: number;
  /** Override the computed EMI (e.g. the exact figure on the sanction letter). */
  emiAmount?: Paise;
  prepayments?: PrepaymentInput[];
}

/**
 * Generate the full amortization schedule.
 *
 * The first EMI falls on `emiDay` of the month *after* `startDate` when the
 * start date is on or after that day, which is how disbursement-to-first-EMI
 * normally works.
 */
export function generateAmortization(input: AmortizationInput): AmortizationSummary {
  const {
    principal,
    annualRatePercent,
    tenureMonths,
    startDate,
    emiDay,
    prepayments = [],
  } = input;

  if (principal <= 0 || tenureMonths <= 0) {
    return {
      rows: [],
      totalInterest: 0,
      totalPrincipal: 0,
      totalPaid: 0,
      months: 0,
      lastPaymentDate: startDate,
    };
  }

  let emi = input.emiAmount ?? calculateEMI(principal, annualRatePercent, tenureMonths);
  const r = monthlyRate(annualRatePercent);

  const prepayByInstallment = new Map<number, PrepaymentInput[]>();
  for (const p of prepayments) {
    const list = prepayByInstallment.get(p.afterInstallment) ?? [];
    list.push(p);
    prepayByInstallment.set(p.afterInstallment, list);
  }

  const rows: AmortizationRow[] = [];
  let balance = principal;
  let n = 1;
  // Hard stop well beyond any real tenure, so a pathological EMI cannot hang the UI.
  const MAX_INSTALLMENTS = Math.max(tenureMonths * 2, tenureMonths + 600);

  // First EMI: same month if emiDay is still ahead, else next month.
  //
  // Both sides must be local-midnight dates. `new Date('2026-04-15')` parses as
  // UTC midnight, which in any timezone west of UTC lands on the previous local
  // day and would push the whole schedule out by a month.
  const start = dayOfMonthClamped(startDate, emiDay);
  const startsLater = start.getTime() > toDate(startDate).getTime();
  let dueDate = startsLater ? start : dayOfMonthClamped(addMonthsClamped(startDate, 1), emiDay);

  while (balance > 0 && n <= MAX_INSTALLMENTS) {
    const opening = balance;
    const interest = Number(new Big(opening).times(r).round(0, Big.roundHalfUp));

    // Final instalment: pay off whatever is left, interest included.
    //
    // Rounding the EMI to the paise leaves a few paise outstanding after the
    // scheduled number of instalments, so the last one must absorb the residue
    // rather than spilling into an extra row. Banks do exactly this.
    let thisEmi = emi;
    const isFinalScheduled = n >= tenureMonths;
    if (isFinalScheduled || opening + interest <= emi) thisEmi = opening + interest;

    let principalPart = thisEmi - interest;
    if (principalPart > opening) principalPart = opening;

    balance = opening - principalPart;

    // Apply any lump sum scheduled after this instalment.
    let prepaidThisMonth = 0;
    const preps = prepayByInstallment.get(n);
    if (preps && balance > 0) {
      for (const p of preps) {
        const applied = Math.min(p.amount, balance);
        balance -= applied;
        prepaidThisMonth += applied;

        if (p.mode === 'REDUCE_EMI' && balance > 0) {
          const remaining = tenureMonths - n;
          if (remaining > 0) emi = calculateEMI(balance, annualRatePercent, remaining);
        }
      }
    }

    rows.push({
      installmentNumber: n,
      dueDate: toISODate(dueDate),
      openingBalance: opening,
      emi: thisEmi,
      interestComponent: interest,
      principalComponent: principalPart,
      closingBalance: balance,
      ...(prepaidThisMonth > 0 ? { prepayment: prepaidThisMonth } : {}),
    });

    dueDate = dayOfMonthClamped(addMonthsClamped(dueDate, 1), emiDay);
    n += 1;
  }

  const totalInterest = sumMoney(rows.map((x) => x.interestComponent));
  const totalPrincipal = sumMoney(rows.map((x) => x.principalComponent + (x.prepayment ?? 0)));

  return {
    rows,
    totalInterest,
    totalPrincipal,
    totalPaid: totalInterest + totalPrincipal,
    months: rows.length,
    lastPaymentDate: rows.length ? rows[rows.length - 1].dueDate : toISODate(startDate),
  };
}

// ---------------------------------------------------------------------------
// Prepayment analysis
// ---------------------------------------------------------------------------

export interface PrepaymentComparison {
  withoutPrepayment: { months: number; totalInterest: Paise; lastPaymentDate: ISODate };
  withPrepayment: { months: number; totalInterest: Paise; lastPaymentDate: ISODate };
  /** Interest saved by prepaying. */
  interestSaved: Paise;
  /** Instalments knocked off the tenure. */
  monthsSaved: number;
  /** New EMI after a REDUCE_EMI prepayment; unchanged for REDUCE_TENURE. */
  newEmi: Paise;
}

/** Quantify exactly what a lump-sum prepayment buys you. */
export function simulatePrepayment(
  input: AmortizationInput,
  prepayment: PrepaymentInput,
): PrepaymentComparison {
  const base = generateAmortization({ ...input, prepayments: [] });
  const withPre = generateAmortization({ ...input, prepayments: [prepayment] });

  const lastRow = withPre.rows[withPre.rows.length - 1];
  const newEmi =
    prepayment.mode === 'REDUCE_EMI' && lastRow
      ? (withPre.rows.find((x) => x.installmentNumber > prepayment.afterInstallment)?.emi ??
         input.emiAmount ??
         calculateEMI(input.principal, input.annualRatePercent, input.tenureMonths))
      : (input.emiAmount ?? calculateEMI(input.principal, input.annualRatePercent, input.tenureMonths));

  return {
    withoutPrepayment: {
      months: base.months,
      totalInterest: base.totalInterest,
      lastPaymentDate: base.lastPaymentDate,
    },
    withPrepayment: {
      months: withPre.months,
      totalInterest: withPre.totalInterest,
      lastPaymentDate: withPre.lastPaymentDate,
    },
    interestSaved: clampZero(base.totalInterest - withPre.totalInterest),
    monthsSaved: Math.max(0, base.months - withPre.months),
    newEmi,
  };
}

/**
 * Outstanding principal after `paidInstallments` EMIs, from the schedule.
 * Cheaper than regenerating the whole table when you only need the balance.
 */
export function outstandingAfter(
  principal: Paise,
  annualRatePercent: number,
  tenureMonths: number,
  paidInstallments: number,
  emiAmount?: Paise,
): Paise {
  if (paidInstallments <= 0) return principal;
  const emi = emiAmount ?? calculateEMI(principal, annualRatePercent, tenureMonths);
  const r = monthlyRate(annualRatePercent);

  let balance = principal;
  for (let i = 0; i < Math.min(paidInstallments, tenureMonths); i++) {
    const interest = Number(new Big(balance).times(r).round(0, Big.roundHalfUp));
    const principalPart = Math.min(emi - interest, balance);
    balance = clampZero(balance - principalPart);
    if (balance === 0) break;
  }
  return balance;
}

/** Per-month interest on the current outstanding - used for "what this loan costs you". */
export function monthlyInterestCost(outstanding: Paise, annualRatePercent: number): Paise {
  return mulMoney(outstanding, Number(monthlyRate(annualRatePercent)));
}
