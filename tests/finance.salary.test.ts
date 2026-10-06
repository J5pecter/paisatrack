import { describe, expect, it } from 'vitest';
import {
  annualiseIncome,
  calculateHRAExemption,
  compareTaxRegimes,
  computeTax,
  ctcToInHand,
  monthlyEquivalent,
} from '@/lib/finance/salary';
import { toPaise, toRupees } from '@/lib/finance/money';

describe('CTC to in-hand', () => {
  it('breaks a Rs 12L CTC down correctly', () => {
    const b = ctcToInHand({
      ctcAnnual: toPaise(12_00_000),
      basicPercent: 45,
      hraPercent: 50,
      pfEmployeePercent: 12,
      pfEmployerPercent: 12,
      gratuityPercent: 4.81,
      professionalTaxMonthly: toPaise(200),
      tdsMonthly: 0,
    });

    expect(b.basicAnnual).toBe(toPaise(5_40_000));          // 45% of CTC
    expect(b.hraAnnual).toBe(toPaise(2_70_000));            // 50% of basic
    expect(b.employerPfAnnual).toBe(toPaise(64_800));       // 12% of basic
    expect(b.employeePfAnnual).toBe(toPaise(64_800));
    expect(b.gratuityAnnual).toBe(toPaise(25_974));         // 4.81% of basic

    // Gross excludes employer PF and gratuity - the employee never sees them.
    expect(b.grossAnnual).toBe(toPaise(12_00_000 - 64_800 - 25_974));
    expect(b.inHandAnnual).toBe(b.grossAnnual - b.employeePfAnnual - toPaise(2_400));
    expect(toRupees(b.inHandMonthly)).toBeCloseTo(86_835.5, 0);
  });

  it('keeps the components summing back to gross', () => {
    const b = ctcToInHand({ ctcAnnual: toPaise(18_00_000) });
    expect(b.basicAnnual + b.hraAnnual + b.specialAllowanceAnnual).toBe(b.grossAnnual);
  });

  it('caps PF at the statutory wage ceiling when asked', () => {
    const uncapped = ctcToInHand({ ctcAnnual: toPaise(50_00_000) });
    const capped = ctcToInHand({ ctcAnnual: toPaise(50_00_000), capPfAtWageCeiling: true });
    expect(capped.employeePfAnnual).toBeLessThan(uncapped.employeePfAnnual);
    expect(capped.employeePfAnnual).toBe(toPaise(21_600)); // 12% of Rs 1.8L
  });

  it('never produces a negative in-hand', () => {
    const b = ctcToInHand({
      ctcAnnual: toPaise(3_00_000),
      tdsMonthly: toPaise(1_00_000), // absurd TDS
    });
    expect(b.inHandAnnual).toBeGreaterThanOrEqual(0);
  });
});

describe('income tax, FY 2025-26 new regime', () => {
  it('is zero up to Rs 12.75L gross, thanks to the 87A rebate', () => {
    const t = computeTax(toPaise(12_75_000), 'NEW');
    expect(t.taxableIncome).toBe(toPaise(12_00_000));
    expect(t.taxBeforeRebate).toBe(toPaise(60_000));
    expect(t.rebate).toBe(toPaise(60_000));
    expect(t.totalTax).toBe(0);
  });

  it('computes Rs 97,500 on a Rs 15L gross', () => {
    const t = computeTax(toPaise(15_00_000), 'NEW');
    expect(t.taxableIncome).toBe(toPaise(14_25_000));
    // 5% of 4L + 10% of 4L + 15% of 2.25L = 93,750, plus 4% cess.
    expect(t.taxBeforeRebate).toBe(toPaise(93_750));
    expect(t.cess).toBe(toPaise(3_750));
    expect(t.totalTax).toBe(toPaise(97_500));
  });

  it('applies marginal relief just past the rebate threshold', () => {
    // Taxable Rs 12,05,000: slab tax is Rs 60,750 but the excess over the
    // threshold is only Rs 5,000, so relief caps the tax at the excess.
    const t = computeTax(toPaise(12_80_000), 'NEW');
    expect(t.taxableIncome).toBe(toPaise(12_05_000));
    expect(t.totalTax).toBe(toPaise(5_200)); // 5,000 + 4% cess
  });

  it('ignores deductions entirely', () => {
    const without = computeTax(toPaise(15_00_000), 'NEW');
    const with80C = computeTax(toPaise(15_00_000), 'NEW', {
      section80C: toPaise(1_50_000),
      section80D: toPaise(25_000),
    });
    expect(with80C.totalTax).toBe(without.totalTax);
  });

  it('adds surcharge above Rs 50L', () => {
    const t = computeTax(toPaise(60_00_000), 'NEW');
    expect(t.surcharge).toBeGreaterThan(0);
  });
});

describe('income tax, FY 2025-26 old regime', () => {
  it('computes Rs 2,57,400 on a Rs 15L gross with no deductions', () => {
    const t = computeTax(toPaise(15_00_000), 'OLD');
    expect(t.taxableIncome).toBe(toPaise(14_50_000));
    expect(t.taxBeforeRebate).toBe(toPaise(2_47_500));
    expect(t.totalTax).toBe(toPaise(2_57_400));
  });

  it('caps 80C at Rs 1.5L and NPS at Rs 50k', () => {
    const t = computeTax(toPaise(15_00_000), 'OLD', {
      section80C: toPaise(3_00_000),      // over the cap
      section80CCD1B: toPaise(1_00_000),  // over the cap
    });
    expect(t.otherDeductions).toBe(toPaise(2_00_000)); // 1.5L + 50k
  });

  it('is zero up to Rs 5.5L gross, thanks to the 87A rebate', () => {
    const t = computeTax(toPaise(5_50_000), 'OLD');
    expect(t.taxableIncome).toBe(toPaise(5_00_000));
    expect(t.totalTax).toBe(0);
  });
});

describe('regime comparison', () => {
  it('recommends the new regime when there is nothing to deduct', () => {
    const c = compareTaxRegimes(toPaise(15_00_000));
    expect(c.recommended).toBe('NEW');
    expect(c.savings).toBeGreaterThan(0);
    expect(c.reason).toBeTruthy();
  });

  it('recommends the old regime once deductions are large enough', () => {
    // After Budget 2025 the new regime wins in most cases. The old regime only
    // pulls ahead in a narrow band: enough income to be past the rebate, with
    // deductions maxed out. At Rs 14L with the full set, old wins Rs 51,480 to
    // Rs 81,900.
    const c = compareTaxRegimes(toPaise(14_00_000), {
      section80C: toPaise(1_50_000),
      section80CCD1B: toPaise(50_000),
      section80D: toPaise(25_000),
      hraExemption: toPaise(2_40_000),
      homeLoanInterest: toPaise(2_00_000),
    });
    expect(c.recommended).toBe('OLD');
    expect(c.oldRegime.totalTax).toBe(toPaise(51_480));
    expect(c.newRegime.totalTax).toBe(toPaise(81_900));
  });

  it('both regimes reach zero on a modest salary with deductions', () => {
    // A Rs 12L salary pays nothing either way - the new regime via the higher
    // rebate, the old via deductions. The tie breaks to the simpler regime.
    const c = compareTaxRegimes(toPaise(12_00_000), {
      section80C: toPaise(1_50_000),
      section80CCD1B: toPaise(50_000),
      section80D: toPaise(25_000),
      hraExemption: toPaise(2_40_000),
      homeLoanInterest: toPaise(2_00_000),
    });
    expect(c.newRegime.totalTax).toBe(0);
    expect(c.oldRegime.totalTax).toBe(0);
    expect(c.recommended).toBe('NEW');
  });

  it('savings is the absolute gap between the two', () => {
    const c = compareTaxRegimes(toPaise(15_00_000));
    expect(c.savings).toBe(Math.abs(c.newRegime.totalTax - c.oldRegime.totalTax));
  });
});

describe('HRA exemption', () => {
  it('takes the least of the three statutory limits', () => {
    // Basic 6L, HRA received 3L, rent 3.6L, metro.
    // 1) 3,00,000  2) 3,60,000 - 60,000 = 3,00,000  3) 50% of 6L = 3,00,000
    expect(
      calculateHRAExemption({
        basicAnnual: toPaise(6_00_000),
        hraReceivedAnnual: toPaise(3_00_000),
        rentPaidAnnual: toPaise(3_60_000),
        isMetro: true,
      }),
    ).toBe(toPaise(3_00_000));
  });

  it('is limited to 40% of basic outside the metros', () => {
    expect(
      calculateHRAExemption({
        basicAnnual: toPaise(6_00_000),
        hraReceivedAnnual: toPaise(3_00_000),
        rentPaidAnnual: toPaise(6_00_000),
        isMetro: false,
      }),
    ).toBe(toPaise(2_40_000));
  });

  it('is zero when no rent is paid', () => {
    expect(
      calculateHRAExemption({
        basicAnnual: toPaise(6_00_000),
        hraReceivedAnnual: toPaise(3_00_000),
        rentPaidAnnual: 0,
        isMetro: true,
      }),
    ).toBe(0);
  });
});

describe('income frequency normalisation', () => {
  it('annualises', () => {
    expect(annualiseIncome(toPaise(50_000), 'MONTHLY')).toBe(toPaise(6_00_000));
    expect(annualiseIncome(toPaise(50_000), 'QUARTERLY')).toBe(toPaise(2_00_000));
    expect(annualiseIncome(toPaise(50_000), 'ANNUAL')).toBe(toPaise(50_000));
  });

  it('gives a monthly equivalent, with one-offs contributing nothing', () => {
    expect(monthlyEquivalent(toPaise(60_000), 'ANNUAL')).toBe(toPaise(5_000));
    expect(monthlyEquivalent(toPaise(30_000), 'QUARTERLY')).toBe(toPaise(10_000));
    expect(monthlyEquivalent(toPaise(1_00_000), 'ONE_TIME')).toBe(0);
  });
});
