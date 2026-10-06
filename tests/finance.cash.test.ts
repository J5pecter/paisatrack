/**
 * Cash and bank accounts.
 *
 * The honest limit of this module: PaisaTrack stores income as a recurring
 * *definition* (amount, frequency, credited-on day), not as discrete credit
 * transactions. So it cannot know what actually landed in an account. Rather
 * than guess, the model is one-directional — you confirm a balance, spending
 * tagged to that account is subtracted from it, and when you next count the
 * real thing the difference is reported as unaccounted.
 *
 * That difference is the useful number. Cash leaks, and the leak is exactly
 * what no app shows you.
 */
import { describe, expect, it } from 'vitest';
import {
  projectAccount,
  reconcile,
  runwayMonths,
  summariseAccounts,
  totalLiquid,
} from '@/lib/finance/cash';
import { toPaise } from '@/lib/finance/money';
import type { CashAccount, Expense } from '@/types';

function account(over: Partial<CashAccount> = {}): CashAccount {
  return {
    id: 'acc_1',
    userId: 'u1',
    name: 'Wallet',
    kind: 'CASH',
    balance: toPaise(5_000),
    balanceAsOf: '2026-03-01',
    includeInNetWorth: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  } as CashAccount;
}

function expense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'exp_' + Math.round(Math.random() * 1e9),
    userId: 'u1',
    amount: toPaise(100),
    category: 'FOOD',
    description: 'Chai',
    date: '2026-03-05',
    paymentMethod: 'CASH',
    cashAccountId: 'acc_1',
    isRecurring: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...over,
  } as Expense;
}

describe('projectAccount', () => {
  it('subtracts spending tagged to the account since the balance was confirmed', () => {
    const p = projectAccount(
      account(),
      [expense({ amount: toPaise(300) }), expense({ amount: toPaise(200) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(toPaise(500));
    expect(p.expected).toBe(toPaise(4_500));
  });

  it('ignores spending on other accounts', () => {
    const p = projectAccount(
      account(),
      [expense({ cashAccountId: 'acc_other', amount: toPaise(900) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
    expect(p.expected).toBe(toPaise(5_000));
  });

  it('ignores untagged spending, because it cannot be attributed', () => {
    const p = projectAccount(
      account(),
      [expense({ cashAccountId: null, amount: toPaise(900) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
  });

  it('ignores credit-card spending even if an account is tagged', () => {
    // A card spend does not leave the bank until the bill is paid, and that
    // payment is its own expense. Counting both would double-count it.
    const p = projectAccount(
      account(),
      [expense({ paymentMethod: 'CREDIT_CARD', amount: toPaise(900) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
  });

  it('treats the confirmed balance as end-of-day, so same-day spends are already in it', () => {
    const p = projectAccount(
      account({ balanceAsOf: '2026-03-05' }),
      [expense({ date: '2026-03-05', amount: toPaise(400) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
  });

  it('ignores anything dated before the balance was confirmed', () => {
    const p = projectAccount(
      account({ balanceAsOf: '2026-03-10' }),
      [expense({ date: '2026-03-01', amount: toPaise(400) })],
      '2026-03-20',
    );
    expect(p.spentSince).toBe(0);
  });

  it('ignores spending dated after the as-of date being asked about', () => {
    // Asking "what should be in there on the 10th" must not subtract the 15th.
    const p = projectAccount(
      account(),
      [expense({ date: '2026-03-15', amount: toPaise(400) })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
  });

  it('ignores deleted expenses', () => {
    const p = projectAccount(
      account(),
      [expense({ amount: toPaise(400), deletedAt: '2026-03-06T00:00:00.000Z' })],
      '2026-03-10',
    );
    expect(p.spentSince).toBe(0);
  });

  it('reports how stale the confirmed balance is', () => {
    const p = projectAccount(account({ balanceAsOf: '2026-03-01' }), [], '2026-03-29');
    expect(p.staleDays).toBe(28);
  });

  it('lets the expected balance go negative rather than clamping a lie to zero', () => {
    // Overspending a wallet means the balance was wrong or something is
    // untracked. Hiding that behind a zero would hide the only useful signal.
    const p = projectAccount(account(), [expense({ amount: toPaise(8_000) })], '2026-03-10');
    expect(p.expected).toBe(toPaise(-3_000));
  });

  it('handles an account with no activity at all', () => {
    const p = projectAccount(account(), [], '2026-03-10');
    expect(p.expected).toBe(toPaise(5_000));
    expect(p.spentSince).toBe(0);
  });
});

describe('reconcile', () => {
  it('reports nothing unaccounted when the count matches', () => {
    const p = projectAccount(account(), [expense({ amount: toPaise(500) })], '2026-03-10');
    const r = reconcile(p, toPaise(4_500));
    expect(r.drift).toBe(0);
    expect(r.matches).toBe(true);
  });

  it('reports a shortfall as money that left without being recorded', () => {
    const p = projectAccount(account(), [expense({ amount: toPaise(500) })], '2026-03-10');
    const r = reconcile(p, toPaise(4_000)); // ₹500 less than expected
    expect(r.drift).toBe(toPaise(-500));
    expect(r.matches).toBe(false);
    expect(r.direction).toBe('SHORT');
  });

  it('reports a surplus, which usually means unrecorded income', () => {
    const p = projectAccount(account(), [], '2026-03-10');
    const r = reconcile(p, toPaise(6_000));
    expect(r.drift).toBe(toPaise(1_000));
    expect(r.direction).toBe('OVER');
  });

  it('is exact in paise — no rounding drift of its own', () => {
    const p = projectAccount(account({ balance: 123_45 }), [], '2026-03-10');
    expect(reconcile(p, 123_44).drift).toBe(-1);
  });
});

describe('totalLiquid', () => {
  it('adds up every account', () => {
    expect(
      totalLiquid([
        account({ balance: toPaise(5_000) }),
        account({ id: 'acc_2', kind: 'BANK', balance: toPaise(45_000) }),
      ]),
    ).toBe(toPaise(50_000));
  });

  it('honours the net-worth opt-out', () => {
    // A joint or business account should be visible without inflating net worth.
    expect(
      totalLiquid([
        account({ balance: toPaise(5_000) }),
        account({ id: 'acc_2', balance: toPaise(45_000), includeInNetWorth: false }),
      ]),
    ).toBe(toPaise(5_000));
  });

  it('excludes deleted accounts', () => {
    expect(
      totalLiquid([
        account({ balance: toPaise(5_000) }),
        account({ id: 'acc_2', balance: toPaise(45_000), deletedAt: '2026-03-01T00:00:00.000Z' }),
      ]),
    ).toBe(toPaise(5_000));
  });

  it('is zero for no accounts, not NaN', () => {
    expect(totalLiquid([])).toBe(0);
  });
});

describe('runwayMonths', () => {
  it('says how many months the cash covers', () => {
    expect(runwayMonths(toPaise(90_000), toPaise(30_000))).toBeCloseTo(3, 5);
  });

  it('returns null when nothing is going out, rather than Infinity', () => {
    // Infinity renders as "Infinity months", which helps nobody.
    expect(runwayMonths(toPaise(90_000), 0)).toBeNull();
  });

  it('returns 0 when there is no cash', () => {
    expect(runwayMonths(0, toPaise(30_000))).toBe(0);
  });

  it('never returns a negative runway', () => {
    expect(runwayMonths(toPaise(-5_000), toPaise(30_000))).toBe(0);
  });
});

describe('summariseAccounts', () => {
  it('splits the total by kind and totals correctly', () => {
    const s = summariseAccounts(
      [
        account({ balance: toPaise(2_000) }),
        account({ id: 'a2', kind: 'BANK', balance: toPaise(48_000) }),
        account({ id: 'a3', kind: 'BANK', balance: toPaise(10_000) }),
      ],
      [],
      '2026-03-10',
    );
    expect(s.cash).toBe(toPaise(2_000));
    expect(s.bank).toBe(toPaise(58_000));
    expect(s.total).toBe(toPaise(60_000));
    expect(s.accounts).toHaveLength(3);
  });

  it('the parts always sum to the total', () => {
    // The invariant that stops the page disagreeing with itself.
    const s = summariseAccounts(
      [
        account({ balance: 1 }),
        account({ id: 'a2', kind: 'BANK', balance: 2 }),
        account({ id: 'a3', kind: 'CASH', balance: 3 }),
      ],
      [],
      '2026-03-10',
    );
    expect(s.cash + s.bank).toBe(s.total);
  });

  it('flags accounts whose confirmed balance has gone stale', () => {
    const s = summariseAccounts(
      [account({ balanceAsOf: '2026-01-01' }), account({ id: 'a2', balanceAsOf: '2026-03-09' })],
      [],
      '2026-03-10',
    );
    expect(s.accounts[0].staleDays).toBeGreaterThan(30);
    expect(s.accounts[1].staleDays).toBe(1);
  });

  it('handles no accounts without producing NaN anywhere', () => {
    const s = summariseAccounts([], [], '2026-03-10');
    expect(s).toMatchObject({ cash: 0, bank: 0, total: 0 });
    expect(s.accounts).toEqual([]);
  });
});
