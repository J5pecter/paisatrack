/**
 * Salary and income tax.
 *
 * CTC -> in-hand, plus a new-vs-old regime comparison for FY 2025-26
 * (assessment year 2026-27), using the slabs introduced in Budget 2025.
 *
 * Two conventions worth knowing, because payslips differ:
 *   - basicPercent is a percentage of CTC.
 *   - hraPercent is a percentage of BASIC (the standard Indian practice:
 *     50% of basic in metros, 40% elsewhere).
 */
import Big from 'big.js';
import type { Paise } from '@/types';
import { clampZero, divMoney, pctOf } from './money';

// ---------------------------------------------------------------------------
// CTC -> in-hand
// ---------------------------------------------------------------------------

export interface CTCInput {
  ctcAnnual: Paise;
  /** Percent of CTC that is Basic. Default 45. */
  basicPercent?: number;
  /** Percent of Basic that is HRA. Default 50 (metro). */
  hraPercent?: number;
  /** Employee PF as a percent of Basic. Default 12. */
  pfEmployeePercent?: number;
  /** Employer PF as a percent of Basic. Default 12. Part of CTC. */
  pfEmployerPercent?: number;
  /** Gratuity accrual as a percent of Basic. Default 4.81. Part of CTC. */
  gratuityPercent?: number;
  /** Professional tax per month. Rs 200 in most states. */
  professionalTaxMonthly?: Paise;
  /** TDS per month. Pass 0 to have it estimated from the regime comparison. */
  tdsMonthly?: Paise;
  otherDeductionsMonthly?: Paise;
  /**
   * Cap PF at the statutory wage ceiling of Rs 15,000/month (Rs 1,800 contribution).
   * Many employers do; many compute on full basic. Default false.
   */
  capPfAtWageCeiling?: boolean;
}

export interface CTCBreakdown {
  ctcAnnual: Paise;
  basicAnnual: Paise;
  hraAnnual: Paise;
  /** Whatever is left of CTC after basic, HRA, employer PF and gratuity. */
  specialAllowanceAnnual: Paise;
  /** True when the basic/HRA percentages given cannot fit inside gross pay. */
  componentsExceedGross: boolean;
  employerPfAnnual: Paise;
  gratuityAnnual: Paise;

  grossAnnual: Paise;
  grossMonthly: Paise;

  employeePfAnnual: Paise;
  professionalTaxAnnual: Paise;
  tdsAnnual: Paise;
  otherDeductionsAnnual: Paise;
  totalDeductionsAnnual: Paise;

  inHandAnnual: Paise;
  inHandMonthly: Paise;

  /** Monthly view, for the payslip-style table. */
  monthly: {
    basic: Paise;
    hra: Paise;
    specialAllowance: Paise;
    gross: Paise;
    employeePf: Paise;
    professionalTax: Paise;
    tds: Paise;
    other: Paise;
    inHand: Paise;
    employerPf: Paise;
  };
}

const PF_WAGE_CEILING_MONTHLY: Paise = 15_00_000; // Rs 15,000

/**
 * Break a CTC down into its components and the monthly take-home.
 *
 * Gross = CTC - employer PF - gratuity (both are CTC components the employee
 * never sees in the bank account). In-hand = gross - employee PF - PT - TDS.
 */
export function ctcToInHand(input: CTCInput): CTCBreakdown {
  const {
    ctcAnnual,
    basicPercent = 45,
    hraPercent = 50,
    pfEmployeePercent = 12,
    pfEmployerPercent = 12,
    gratuityPercent = 4.81,
    professionalTaxMonthly = 20_000, // Rs 200
    tdsMonthly = 0,
    otherDeductionsMonthly = 0,
    capPfAtWageCeiling = false,
  } = input;

  const basicAnnual = pctOf(ctcAnnual, basicPercent);
  const hraAnnual = pctOf(basicAnnual, hraPercent);

  const pfBaseAnnual = capPfAtWageCeiling
    ? Math.min(basicAnnual, PF_WAGE_CEILING_MONTHLY * 12)
    : basicAnnual;

  const employerPfAnnual = pctOf(pfBaseAnnual, pfEmployerPercent);
  const employeePfAnnual = pctOf(pfBaseAnnual, pfEmployeePercent);
  const gratuityAnnual = pctOf(basicAnnual, gratuityPercent);

  const grossAnnual = clampZero(ctcAnnual - employerPfAnnual - gratuityAnnual);

  // Basic + HRA can only exceed gross if the percentages given are impossible
  // (e.g. 90% basic with 100% HRA). Rather than silently clamping the remainder
  // to zero and over-reporting pay, cap HRA at what is actually left and flag it
  // so the UI can tell the user their structure does not add up.
  const componentsExceedGross = basicAnnual + hraAnnual > grossAnnual;
  const basicReported = Math.min(basicAnnual, grossAnnual);
  const hraReported = Math.min(hraAnnual, clampZero(grossAnnual - basicReported));
  const specialAllowanceAnnual = clampZero(grossAnnual - basicReported - hraReported);

  const professionalTaxAnnual = professionalTaxMonthly * 12;
  const tdsAnnual = tdsMonthly * 12;
  const otherDeductionsAnnual = otherDeductionsMonthly * 12;
  const totalDeductionsAnnual =
    employeePfAnnual + professionalTaxAnnual + tdsAnnual + otherDeductionsAnnual;

  const inHandAnnual = clampZero(grossAnnual - totalDeductionsAnnual);

  const grossMonthly = divMoney(grossAnnual, 12);
  const basicMonthly = divMoney(basicReported, 12);
  const hraMonthly = divMoney(hraReported, 12);

  return {
    ctcAnnual,
    basicAnnual: basicReported,
    hraAnnual: hraReported,
    specialAllowanceAnnual,
    componentsExceedGross,
    employerPfAnnual,
    gratuityAnnual,
    grossAnnual,
    grossMonthly,
    employeePfAnnual,
    professionalTaxAnnual,
    tdsAnnual,
    otherDeductionsAnnual,
    totalDeductionsAnnual,
    inHandAnnual,
    inHandMonthly: divMoney(inHandAnnual, 12),
    monthly: {
      basic: basicMonthly,
      hra: hraMonthly,
      // Derived as the remainder so the payslip column always adds up, rather
      // than rounding each row independently and landing a paisa or two out.
      specialAllowance: clampZero(grossMonthly - basicMonthly - hraMonthly),
      gross: grossMonthly,
      employeePf: divMoney(employeePfAnnual, 12),
      professionalTax: professionalTaxMonthly,
      tds: tdsMonthly,
      other: otherDeductionsMonthly,
      inHand: divMoney(inHandAnnual, 12),
      employerPf: divMoney(employerPfAnnual, 12),
    },
  };
}

// ---------------------------------------------------------------------------
// Income tax, FY 2025-26 (AY 2026-27)
// ---------------------------------------------------------------------------

interface Slab {
  upto: Paise;
  rate: number;
}

/** New regime slabs as revised in Budget 2025. */
const NEW_REGIME_SLABS: Slab[] = [
  { upto: 4_00_000_00, rate: 0 },
  { upto: 8_00_000_00, rate: 5 },
  { upto: 12_00_000_00, rate: 10 },
  { upto: 16_00_000_00, rate: 15 },
  { upto: 20_00_000_00, rate: 20 },
  { upto: 24_00_000_00, rate: 25 },
  { upto: Infinity, rate: 30 },
];

const OLD_REGIME_SLABS: Slab[] = [
  { upto: 2_50_000_00, rate: 0 },
  { upto: 5_00_000_00, rate: 5 },
  { upto: 10_00_000_00, rate: 20 },
  { upto: Infinity, rate: 30 },
];

export const NEW_REGIME_STANDARD_DEDUCTION: Paise = 75_000_00;
export const OLD_REGIME_STANDARD_DEDUCTION: Paise = 50_000_00;

/** Section 87A: full rebate below this taxable income. */
const NEW_REGIME_REBATE_LIMIT: Paise = 12_00_000_00;
const NEW_REGIME_MAX_REBATE: Paise = 60_000_00;
const OLD_REGIME_REBATE_LIMIT: Paise = 5_00_000_00;
const OLD_REGIME_MAX_REBATE: Paise = 12_500_00;

const CESS_RATE = 4;

function taxFromSlabs(taxableIncome: Paise, slabs: Slab[]): Paise {
  if (taxableIncome <= 0) return 0;
  let tax = new Big(0);
  let previousCeiling = 0;

  for (const slab of slabs) {
    if (taxableIncome <= previousCeiling) break;
    const ceiling = slab.upto === Infinity ? taxableIncome : Math.min(slab.upto, taxableIncome);
    const amountInSlab = ceiling - previousCeiling;
    if (amountInSlab > 0 && slab.rate > 0) {
      tax = tax.plus(new Big(amountInSlab).times(slab.rate).div(100));
    }
    previousCeiling = slab.upto === Infinity ? taxableIncome : slab.upto;
  }
  return Number(tax.round(0, Big.roundHalfUp));
}

/** Income levels at which a higher surcharge rate starts to apply. */
const SURCHARGE_THRESHOLDS: Paise[] = [
  50_00_000_00,
  1_00_00_000_00,
  2_00_00_000_00,
  5_00_00_000_00,
];

/** Surcharge on high incomes. The new regime caps the top rate at 25%. */
function surchargeRate(totalIncome: Paise, regime: 'NEW' | 'OLD'): number {
  if (totalIncome > 5_00_00_000_00) return regime === 'NEW' ? 25 : 37;
  if (totalIncome > 2_00_00_000_00) return 25;
  if (totalIncome > 1_00_00_000_00) return 15;
  if (totalIncome > 50_00_000_00) return 10;
  return 0;
}

export interface TaxDeductions {
  /** 80C: PF, ELSS, life insurance, principal repayment. Capped at Rs 1.5L. */
  section80C?: Paise;
  /** 80D: health insurance premium. */
  section80D?: Paise;
  /** 80CCD(1B): additional NPS. Capped at Rs 50,000. */
  section80CCD1B?: Paise;
  /** HRA exemption, already computed. See calculateHRAExemption(). */
  hraExemption?: Paise;
  /** Section 24(b): home loan interest on a self-occupied property. Capped at Rs 2L. */
  homeLoanInterest?: Paise;
  otherDeductions?: Paise;
}

export interface TaxComputation {
  regime: 'NEW' | 'OLD';
  grossIncome: Paise;
  standardDeduction: Paise;
  otherDeductions: Paise;
  taxableIncome: Paise;
  taxBeforeRebate: Paise;
  rebate: Paise;
  surcharge: Paise;
  cess: Paise;
  totalTax: Paise;
  effectiveRatePercent: number;
  monthlyTds: Paise;
}

/** Tax under one regime. Deductions are ignored entirely under the new regime. */
export function computeTax(
  grossIncome: Paise,
  regime: 'NEW' | 'OLD',
  deductions: TaxDeductions = {},
): TaxComputation {
  const isNew = regime === 'NEW';
  const standardDeduction = isNew ? NEW_REGIME_STANDARD_DEDUCTION : OLD_REGIME_STANDARD_DEDUCTION;

  let otherDeductions = 0;
  if (!isNew) {
    const c80 = Math.min(deductions.section80C ?? 0, 1_50_000_00);
    const nps = Math.min(deductions.section80CCD1B ?? 0, 50_000_00);
    const homeLoan = Math.min(deductions.homeLoanInterest ?? 0, 2_00_000_00);
    // 80D caps at Rs 25,000 self + Rs 25,000 parents, rising to Rs 50,000 each
    // where senior citizens are covered - Rs 1,00,000 is the statutory ceiling.
    const health = Math.min(deductions.section80D ?? 0, 1_00_000_00);
    otherDeductions =
      c80 + nps + homeLoan + health +
      (deductions.hraExemption ?? 0) + (deductions.otherDeductions ?? 0);
  }

  const taxableIncome = clampZero(grossIncome - standardDeduction - otherDeductions);
  const slabs = isNew ? NEW_REGIME_SLABS : OLD_REGIME_SLABS;
  const taxBeforeRebate = taxFromSlabs(taxableIncome, slabs);

  // Section 87A rebate.
  const rebateLimit = isNew ? NEW_REGIME_REBATE_LIMIT : OLD_REGIME_REBATE_LIMIT;
  const maxRebate = isNew ? NEW_REGIME_MAX_REBATE : OLD_REGIME_MAX_REBATE;
  let rebate = taxableIncome <= rebateLimit ? Math.min(taxBeforeRebate, maxRebate) : 0;

  let taxAfterRebate = clampZero(taxBeforeRebate - rebate);

  // Marginal relief on the 87A rebate: crossing the threshold must never cost
  // more in tax than the amount by which you crossed it. This proviso exists
  // only under section 115BAC - the old regime's 87A is a hard cliff.
  if (isNew && taxableIncome > rebateLimit) {
    const excess = taxableIncome - rebateLimit;
    if (taxAfterRebate > excess) {
      const relief = taxAfterRebate - excess;
      rebate += relief;
      taxAfterRebate = excess;
    }
  }

  const surcharge = surchargeWithMarginalRelief(taxableIncome, taxAfterRebate, slabs, regime);
  const cess = pctOf(taxAfterRebate + surcharge, CESS_RATE);
  const totalTax = taxAfterRebate + surcharge + cess;

  return {
    regime,
    grossIncome,
    standardDeduction,
    otherDeductions,
    taxableIncome,
    taxBeforeRebate,
    rebate,
    surcharge,
    cess,
    totalTax,
    effectiveRatePercent:
      grossIncome > 0
        ? Number(new Big(totalTax).times(100).div(grossIncome).round(2, Big.roundHalfUp))
        : 0,
    monthlyTds: divMoney(totalTax, 12),
  };
}

/**
 * Surcharge, with the statutory marginal relief.
 *
 * Without it, earning one rupee past Rs 50,00,000 would cost several lakh in
 * surcharge. The relief caps the total tax so that crossing a threshold never
 * costs more than the amount by which you crossed it.
 */
function surchargeWithMarginalRelief(
  taxableIncome: Paise,
  taxAfterRebate: Paise,
  slabs: Slab[],
  regime: 'NEW' | 'OLD',
): Paise {
  const rate = surchargeRate(taxableIncome, regime);
  if (rate === 0) return 0;

  let surcharge = pctOf(taxAfterRebate, rate);

  // The highest threshold this income has passed.
  const threshold = [...SURCHARGE_THRESHOLDS]
    .reverse()
    .find((t) => taxableIncome > t);
  if (threshold === undefined) return surcharge;

  // Total tax payable by someone sitting exactly on the threshold.
  const taxAtThreshold = taxFromSlabs(threshold, slabs);
  const surchargeAtThreshold = pctOf(taxAtThreshold, surchargeRate(threshold, regime));
  const totalAtThreshold = taxAtThreshold + surchargeAtThreshold;

  const excess = taxableIncome - threshold;
  if (taxAfterRebate + surcharge - totalAtThreshold > excess) {
    surcharge = clampZero(totalAtThreshold + excess - taxAfterRebate);
  }
  return surcharge;
}

export interface RegimeComparison {
  newRegime: TaxComputation;
  oldRegime: TaxComputation;
  recommended: 'NEW' | 'OLD';
  /** Tax saved by taking the recommended regime. */
  savings: Paise;
  reason: string;
}

/** Compute both regimes and say which one wins. */
export function compareTaxRegimes(
  grossIncome: Paise,
  deductions: TaxDeductions = {},
): RegimeComparison {
  const newRegime = computeTax(grossIncome, 'NEW', deductions);
  const oldRegime = computeTax(grossIncome, 'OLD', deductions);

  const newWins = newRegime.totalTax <= oldRegime.totalTax;
  const savings = Math.abs(newRegime.totalTax - oldRegime.totalTax);

  const reason = newWins
    ? oldRegime.otherDeductions > 0
      ? `Even with ${formatDeductionSummary(oldRegime.otherDeductions)} of deductions, the new regime's lower slabs come out ahead.`
      : 'With no meaningful deductions to claim, the new regime is clearly better.'
    : `Your deductions (${formatDeductionSummary(oldRegime.otherDeductions)}) are large enough that the old regime wins.`;

  return {
    newRegime,
    oldRegime,
    recommended: newWins ? 'NEW' : 'OLD',
    savings,
    reason,
  };
}

function formatDeductionSummary(paise: Paise): string {
  const lakhs = paise / 1_00_000_00;
  return lakhs >= 1 ? `Rs ${lakhs.toFixed(1)}L` : `Rs ${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

/**
 * HRA exemption under section 10(13A) - the least of:
 *   1. actual HRA received
 *   2. rent paid minus 10% of basic
 *   3. 50% of basic (metro) or 40% (non-metro)
 * Only relevant under the old regime.
 */
export function calculateHRAExemption(params: {
  basicAnnual: Paise;
  hraReceivedAnnual: Paise;
  rentPaidAnnual: Paise;
  isMetro: boolean;
}): Paise {
  const { basicAnnual, hraReceivedAnnual, rentPaidAnnual, isMetro } = params;
  const rentMinusTenPercent = clampZero(rentPaidAnnual - pctOf(basicAnnual, 10));
  const cityLimit = pctOf(basicAnnual, isMetro ? 50 : 40);
  return Math.max(0, Math.min(hraReceivedAnnual, rentMinusTenPercent, cityLimit));
}

/** Annualise an income entry for year-to-date and projection maths. */
export function annualiseIncome(amount: Paise, frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'ONE_TIME'): Paise {
  switch (frequency) {
    case 'MONTHLY': return amount * 12;
    case 'QUARTERLY': return amount * 4;
    case 'ANNUAL': return amount;
    case 'ONE_TIME': return amount;
  }
}

/** Monthly equivalent of an income entry. ONE_TIME contributes nothing monthly. */
export function monthlyEquivalent(amount: Paise, frequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | 'ONE_TIME'): Paise {
  switch (frequency) {
    case 'MONTHLY': return amount;
    case 'QUARTERLY': return divMoney(amount, 3);
    case 'ANNUAL': return divMoney(amount, 12);
    case 'ONE_TIME': return 0;
  }
}
