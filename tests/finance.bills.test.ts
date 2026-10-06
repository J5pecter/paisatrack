import { describe, expect, it } from 'vitest';
import {
  billDueDate,
  billEntryStatus,
  billFallsDueIn,
  calculateElectricityRate,
  detectConsumptionSpike,
  electricitySeries,
  generateMonthlyBillEntries,
  monthlyBillTotal,
  normalisedMonthlyCost,
  totalMonthlyCommitment,
  unpaidBillTotal,
  upcomingBills,
} from '@/lib/finance/bills';
import { toPaise } from '@/lib/finance/money';
import type { Bill, BillEntry } from '@/types';

function bill(over: Partial<Bill> = {}): Bill {
  return {
    id: 'b1',
    userId: 'u1',
    name: 'Flat rent',
    category: 'RENT',
    type: 'FIXED',
    defaultAmount: toPaise(18_000),
    frequency: 'MONTHLY',
    dueDay: 5,
    isAutopay: false,
    isActive: true,
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

function entry(over: Partial<BillEntry> = {}): BillEntry {
  return {
    id: 'e1',
    billId: 'b1',
    billingMonth: '2026-06',
    amount: toPaise(18_000),
    dueDate: '2026-06-05',
    paidOn: null,
    status: 'PENDING',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  };
}

describe('which months a bill falls due in', () => {
  it('monthly bills fall due every month', () => {
    expect(billFallsDueIn(bill(), '2026-06')).toBe(true);
    expect(billFallsDueIn(bill(), '2026-07')).toBe(true);
  });

  it('quarterly bills fall due every third month from the anchor', () => {
    const b = bill({ frequency: 'QUARTERLY', anchorMonth: 1 });
    expect(billFallsDueIn(b, '2026-01')).toBe(true);
    expect(billFallsDueIn(b, '2026-04')).toBe(true);
    expect(billFallsDueIn(b, '2026-07')).toBe(true);
    expect(billFallsDueIn(b, '2026-02')).toBe(false);
    expect(billFallsDueIn(b, '2026-03')).toBe(false);
  });

  it('quarterly maths works when the anchor is late in the year', () => {
    const b = bill({ frequency: 'QUARTERLY', anchorMonth: 11 });
    expect(billFallsDueIn(b, '2026-11')).toBe(true);
    expect(billFallsDueIn(b, '2027-02')).toBe(true); // wraps the year correctly
    expect(billFallsDueIn(b, '2026-12')).toBe(false);
  });

  it('annual bills fall due once', () => {
    const b = bill({ frequency: 'ANNUAL', anchorMonth: 7 });
    expect(billFallsDueIn(b, '2026-07')).toBe(true);
    expect(billFallsDueIn(b, '2026-08')).toBe(false);
  });

  it('inactive bills never fall due', () => {
    expect(billFallsDueIn(bill({ isActive: false }), '2026-06')).toBe(false);
  });
});

describe('due dates', () => {
  it('clamps to the end of a short month', () => {
    expect(billDueDate(bill({ dueDay: 31 }), '2026-02')).toBe('2026-02-28');
    expect(billDueDate(bill({ dueDay: 31 }), '2028-02')).toBe('2028-02-29');
    expect(billDueDate(bill({ dueDay: 5 }), '2026-06')).toBe('2026-06-05');
  });
});

describe('generating a month of entries', () => {
  const now = new Date('2026-06-15T00:00:00');

  it('creates one entry per due bill', () => {
    const bills = [bill({ id: 'b1' }), bill({ id: 'b2', name: 'Internet', dueDay: 3 })];
    const created = generateMonthlyBillEntries(bills, '2026-06', [], now);
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.billId).sort()).toEqual(['b1', 'b2']);
  });

  it('does not duplicate an entry that already exists', () => {
    const bills = [bill({ id: 'b1' }), bill({ id: 'b2' })];
    const existing = [entry({ billId: 'b1', billingMonth: '2026-06' })];
    const created = generateMonthlyBillEntries(bills, '2026-06', existing, now);
    expect(created).toHaveLength(1);
    expect(created[0].billId).toBe('b2');
  });

  it('prefills fixed bills and leaves variable ones at zero', () => {
    const bills = [
      bill({ id: 'fixed', type: 'FIXED', defaultAmount: toPaise(999) }),
      bill({ id: 'var', type: 'VARIABLE', defaultAmount: toPaise(1_400) }),
    ];
    const created = generateMonthlyBillEntries(bills, '2026-06', [], now);
    expect(created.find((c) => c.billId === 'fixed')?.amount).toBe(toPaise(999));
    // Variable bills must prompt for the real figure, not guess.
    expect(created.find((c) => c.billId === 'var')?.amount).toBe(0);
  });

  it('marks an entry overdue when its due date has already passed', () => {
    const created = generateMonthlyBillEntries([bill({ dueDay: 5 })], '2026-06', [], now);
    expect(created[0].status).toBe('OVERDUE');
  });

  it('leaves autopay bills pending rather than overdue', () => {
    const created = generateMonthlyBillEntries(
      [bill({ dueDay: 5, isAutopay: true })],
      '2026-06',
      [],
      now,
    );
    expect(created[0].status).toBe('PENDING');
  });

  it('skips a quarterly bill in an off month', () => {
    const b = bill({ frequency: 'QUARTERLY', anchorMonth: 1 });
    expect(generateMonthlyBillEntries([b], '2026-02', [], now)).toHaveLength(0);
  });
});

describe('entry status', () => {
  const now = new Date('2026-06-15T00:00:00');

  it('is PAID once a payment date is recorded', () => {
    expect(billEntryStatus(entry({ paidOn: '2026-06-04' }), now)).toBe('PAID');
  });

  it('is OVERDUE past the due date', () => {
    expect(billEntryStatus(entry({ dueDate: '2026-06-05' }), now)).toBe('OVERDUE');
  });

  it('is PENDING before the due date', () => {
    expect(billEntryStatus(entry({ dueDate: '2026-06-20' }), now)).toBe('PENDING');
  });

  it('leaves a skipped entry alone', () => {
    expect(billEntryStatus(entry({ status: 'SKIPPED' }), now)).toBe('SKIPPED');
  });
});

describe('electricity', () => {
  it('computes the rate per unit', () => {
    expect(calculateElectricityRate(100, toPaise(840))).toBe(toPaise(8.4));
    expect(calculateElectricityRate(0, toPaise(840))).toBe(0);
  });

  it('builds a series across the requested months', () => {
    const entries = [
      entry({ id: 'a', billingMonth: '2026-05', unitsConsumed: 150, amount: toPaise(1_260) }),
      entry({ id: 'b', billingMonth: '2026-06', unitsConsumed: 380, amount: toPaise(3_344) }),
    ];
    const series = electricitySeries(entries, ['2026-04', '2026-05', '2026-06']);
    expect(series).toHaveLength(3);
    expect(series[0].units).toBe(0); // no data for April
    expect(series[1].units).toBe(150);
    expect(series[2].ratePerUnit).toBe(toPaise(8.8));
  });

  it('flags a consumption spike', () => {
    const series = electricitySeries(
      [
        entry({ id: 'a', billingMonth: '2026-03', unitsConsumed: 150, amount: toPaise(1_260) }),
        entry({ id: 'b', billingMonth: '2026-04', unitsConsumed: 160, amount: toPaise(1_344) }),
        entry({ id: 'c', billingMonth: '2026-05', unitsConsumed: 140, amount: toPaise(1_176) }),
        entry({ id: 'd', billingMonth: '2026-06', unitsConsumed: 390, amount: toPaise(3_432) }),
      ],
      ['2026-03', '2026-04', '2026-05', '2026-06'],
    );
    const spike = detectConsumptionSpike(series);
    expect(spike?.month).toBe('2026-06');
    expect(spike?.units).toBe(390);
    expect(spike?.increasePercent).toBeGreaterThan(100);
  });

  it('does not cry spike on steady usage', () => {
    const series = electricitySeries(
      [
        entry({ id: 'a', billingMonth: '2026-04', unitsConsumed: 150, amount: toPaise(1_260) }),
        entry({ id: 'b', billingMonth: '2026-05', unitsConsumed: 155, amount: toPaise(1_302) }),
        entry({ id: 'c', billingMonth: '2026-06', unitsConsumed: 160, amount: toPaise(1_344) }),
      ],
      ['2026-04', '2026-05', '2026-06'],
    );
    expect(detectConsumptionSpike(series)).toBeNull();
  });

  it('needs enough history before calling anything a spike', () => {
    const series = electricitySeries(
      [entry({ id: 'a', billingMonth: '2026-06', unitsConsumed: 900, amount: toPaise(8_000) })],
      ['2026-06'],
    );
    expect(detectConsumptionSpike(series)).toBeNull();
  });
});

describe('totals', () => {
  const entries = [
    entry({ id: 'a', amount: toPaise(18_000), status: 'PAID' }),
    entry({ id: 'b', amount: toPaise(999), status: 'PENDING' }),
    entry({ id: 'c', amount: toPaise(350), status: 'OVERDUE' }),
    entry({ id: 'd', amount: toPaise(5_000), status: 'SKIPPED' }),
  ];

  it('counts everything except skipped entries', () => {
    expect(monthlyBillTotal(entries, '2026-06')).toBe(toPaise(19_349));
  });

  it('counts only what is still owed', () => {
    expect(unpaidBillTotal(entries, '2026-06')).toBe(toPaise(1_349));
  });

  it('normalises frequencies to a monthly figure', () => {
    expect(normalisedMonthlyCost(bill({ frequency: 'MONTHLY', defaultAmount: toPaise(1_200) })))
      .toBe(toPaise(1_200));
    expect(normalisedMonthlyCost(bill({ frequency: 'QUARTERLY', defaultAmount: toPaise(1_200) })))
      .toBe(toPaise(400));
    expect(normalisedMonthlyCost(bill({ frequency: 'ANNUAL', defaultAmount: toPaise(1_200) })))
      .toBe(toPaise(100));
  });

  it('sums the monthly commitment across active bills only', () => {
    const total = totalMonthlyCommitment([
      bill({ id: 'a', defaultAmount: toPaise(18_000) }),
      bill({ id: 'b', defaultAmount: toPaise(1_200), frequency: 'ANNUAL' }),
      bill({ id: 'c', defaultAmount: toPaise(9_999), isActive: false }),
    ]);
    expect(total).toBe(toPaise(18_100));
  });
});

describe('upcoming bills', () => {
  const now = new Date('2026-06-01T00:00:00');

  it('returns unpaid bills inside the horizon, soonest first', () => {
    const bills = [bill({ id: 'b1', name: 'Rent' }), bill({ id: 'b2', name: 'Internet' })];
    const entries = [
      entry({ id: 'e1', billId: 'b1', dueDate: '2026-06-20', status: 'PENDING' }),
      entry({ id: 'e2', billId: 'b2', dueDate: '2026-06-05', status: 'PENDING' }),
    ];
    const upcoming = upcomingBills(bills, entries, 30, now);
    expect(upcoming.map((u) => u.bill.name)).toEqual(['Internet', 'Rent']);
  });

  it('excludes paid bills and anything past the horizon', () => {
    const bills = [bill({ id: 'b1' }), bill({ id: 'b2' })];
    const entries = [
      entry({ id: 'e1', billId: 'b1', dueDate: '2026-06-05', status: 'PAID' }),
      entry({ id: 'e2', billId: 'b2', dueDate: '2026-09-05', status: 'PENDING' }),
    ];
    expect(upcomingBills(bills, entries, 30, now)).toHaveLength(0);
  });

  it('ignores an entry whose bill has been deleted', () => {
    const entries = [entry({ id: 'e1', billId: 'gone', status: 'PENDING' })];
    expect(upcomingBills([], entries, 30, now)).toHaveLength(0);
  });
});
