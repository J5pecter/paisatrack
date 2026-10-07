/**
 * Reading transactions out of a statement.
 *
 * The fixtures below are shaped like the real thing — HDFC and ICICI bank
 * statements, a credit card statement, a PhonePe export — because the whole
 * difficulty of this feature is that no two banks lay a statement out the same
 * way, and a parser tested against a tidy invented format proves nothing.
 *
 * The property that matters most: a row whose direction is guessed must be
 * marked LOW confidence, so the review screen can show the user what to check.
 * Importing a credit as a debit silently is the failure worth preventing.
 */
import { describe, expect, it } from 'vitest';
import { dedupe, extractTransactions, fingerprint, guessCategory } from '@/lib/import/statement';

/** HDFC-style: date, narration, ref, value date, debit, credit, balance. */
const HDFC = `
Statement of Account
Date       Narration                              Chq/Ref No   Withdrawal   Deposit      Balance
01/04/2026 UPI-SWIGGY ORDER-9876543210                            450.00                 50,000.00
03/04/2026 UPI-BLINKIT GROCERY-1122334455                       1,250.00                 48,750.00
05/04/2026 SALARY CREDIT APR 2026                                             85,000.00  1,33,750.00
07/04/2026 ACH-D- HDFC HOME LOAN EMI                           24,500.00                 1,09,250.00
Closing Balance                                                                          1,09,250.00
`.trim().split('\n');

/** ICICI-style: a single amount column with Dr/Cr markers and no balance. */
const ICICI = `
Txn Date   Description                      Amount
15-Mar-2026 NEFT-RAHUL SHARMA               5,000.00 Cr
16-Mar-2026 ATM WDL BANGALORE               2,000.00 Dr
17-Mar-2026 AMAZON RETAIL PAYMENT           1,899.00 Dr
`.trim().split('\n');

/** PhonePe-style export. */
const PHONEPE = `
Transaction Statement
Mar 15, 2026  Paid to SWIGGY           DEBIT   ₹450.00
Mar 16, 2026  Received from Rahul      CREDIT  ₹1,200.00
Mar 18, 2026  Paid to Indian Oil       DEBIT   ₹2,000.00
`.trim().split('\n');

describe('extractTransactions — bank statement with a balance column', () => {
  const r = extractTransactions(HDFC, 'BANK');

  it('finds every transaction row and ignores the header and footer', () => {
    expect(r.transactions).toHaveLength(4);
  });

  it('reads the amounts in paise', () => {
    expect(r.transactions[0].amount).toBe(45_000);
    expect(r.transactions[1].amount).toBe(1_25_000);
    expect(r.transactions[2].amount).toBe(85_000_00);
  });

  it('uses the running balance to decide direction, not keywords', () => {
    // This is the point of the whole parser. The salary row carries no "Cr"
    // marker anywhere — the only evidence it is money IN is that the balance
    // went up, and that evidence is conclusive.
    expect(r.transactions[2].direction).toBe('CREDIT');
    expect(r.transactions[2].confidence).toBe('HIGH');

    expect(r.transactions[0].direction).toBe('DEBIT');
    expect(r.transactions[3].direction).toBe('DEBIT');
  });

  it('records the running balance it read', () => {
    expect(r.transactions[1].balance).toBe(48_750_00);
    expect(r.transactions[2].balance).toBe(1_33_750_00);
  });

  it('strips the date, amounts and reference noise out of the description', () => {
    expect(r.transactions[0].description).toMatch(/SWIGGY/);
    expect(r.transactions[0].description).not.toMatch(/450\.00|01\/04\/2026|9876543210/);
  });

  it('guesses a category from the narration', () => {
    expect(r.transactions[0].category).toBe('FOOD');
    expect(r.transactions[1].category).toBe('GROCERIES');
    expect(r.transactions[3].category).toBe('EMI');
  });

  it('leaves money coming in uncategorised rather than guessing', () => {
    expect(r.transactions[2].category).toBe('OTHER');
  });
});

describe('extractTransactions — Dr/Cr markers, no balance column', () => {
  const r = extractTransactions(ICICI, 'BANK');

  it('reads all three rows', () => {
    expect(r.transactions).toHaveLength(3);
  });

  it('falls back to the explicit marker when there is no balance', () => {
    expect(r.transactions[0].direction).toBe('CREDIT');
    expect(r.transactions[1].direction).toBe('DEBIT');
    expect(r.transactions[0].confidence).toBe('MEDIUM');
  });

  it('does not invent a balance when the statement prints none', () => {
    expect(r.transactions[0].balance).toBeUndefined();
  });
});

describe('extractTransactions — UPI app export', () => {
  const r = extractTransactions(PHONEPE, 'UPI');

  it('reads the month-first dates these apps use', () => {
    expect(r.transactions[0].date).toBe('2026-03-15');
    expect(r.transactions[2].date).toBe('2026-03-18');
  });

  it('reads direction from "Paid to" and "Received from"', () => {
    expect(r.transactions[0].direction).toBe('DEBIT');
    expect(r.transactions[1].direction).toBe('CREDIT');
  });

  it('categorises from the merchant', () => {
    expect(r.transactions[0].category).toBe('FOOD');
    expect(r.transactions[2].category).toBe('FUEL');
  });
});

describe('column position', () => {
  it('reads direction from which column the amount sits in', () => {
    // Most Indian statements print separate withdrawal and deposit columns.
    // The very first row has no previous balance to compare against, so its
    // column is the only evidence available — and it is good evidence.
    const r = extractTransactions(HDFC, 'BANK');
    expect(r.transactions[0].confidence).toBe('HIGH');
    expect(r.transactions[0].direction).toBe('DEBIT');
    expect(r.warnings.join(' ')).not.toMatch(/no debit\/credit marker/);
  });

  it('does not invent two columns out of one ragged one', () => {
    // Right-aligned amounts of differing length jitter by a few characters.
    // Treating that as a debit/credit split would flip rows at random.
    const singleColumn = [
      '01/04/2026 MERCHANT A    1,00,000.00',
      '02/04/2026 MERCHANT B       5,000.00',
      '03/04/2026 MERCHANT C         450.00',
    ];
    const r = extractTransactions(singleColumn, 'BANK');
    expect(r.transactions.every((t) => t.direction === 'DEBIT')).toBe(true);
    // No balance, no marker, no real column split: it must admit it guessed.
    expect(r.transactions.every((t) => t.confidence === 'LOW')).toBe(true);
  });
});

describe('confidence', () => {
  it('flags a row it had to guess, so review can surface it', () => {
    const r = extractTransactions(
      ['01/04/2026  SOME UNLABELLED TRANSFER   1,000.00'],
      'BANK',
    );
    expect(r.transactions[0].confidence).toBe('LOW');
    expect(r.warnings.join(' ')).toMatch(/no debit\/credit marker/);
  });

  it('treats an unmarked card row as a purchase, which is its normal case', () => {
    const r = extractTransactions(['01/04/2026  SOME MERCHANT   1,000.00'], 'CARD');
    expect(r.transactions[0].direction).toBe('DEBIT');
    expect(r.transactions[0].confidence).toBe('MEDIUM');
  });
});

describe('robustness', () => {
  it('returns nothing for a document with no transactions', () => {
    const r = extractTransactions(['Statement of Account', 'Customer Name: A B', 'Page 1 of 3']);
    expect(r.transactions).toEqual([]);
  });

  it('handles an empty document', () => {
    expect(extractTransactions([]).transactions).toEqual([]);
  });

  it('ignores a summary line that has amounts but no date', () => {
    const r = extractTransactions([
      'Opening Balance 50,000.00',
      '01/04/2026 SWIGGY 450.00',
      'Closing Balance 49,550.00',
    ]);
    expect(r.transactions).toHaveLength(1);
  });

  it('never emits a zero-value transaction', () => {
    const r = extractTransactions(['01/04/2026 REVERSAL 0.00 50,000.00']);
    expect(r.transactions.every((t) => t.amount > 0)).toBe(true);
  });
});

describe('guessCategory', () => {
  it('prefers the more specific merchant', () => {
    // Swiggy Instamart is groceries; plain Swiggy is a meal.
    expect(guessCategory('UPI-SWIGGY INSTAMART')).toBe('GROCERIES');
    expect(guessCategory('UPI-SWIGGY ORDER')).toBe('FOOD');
  });

  it('falls back to OTHER rather than guessing wildly', () => {
    expect(guessCategory('NEFT TRANSFER TO SELF')).toBe('OTHER');
  });
});

describe('dedupe', () => {
  const rows = extractTransactions(HDFC, 'BANK').transactions;

  it('drops rows already stored', () => {
    const existing = new Set([rows[0].fingerprint, rows[1].fingerprint]);
    const r = dedupe(rows, existing);
    expect(r.fresh).toHaveLength(2);
    expect(r.duplicates).toBe(2);
  });

  it('drops repeats inside a single import too', () => {
    const r = dedupe([...rows, ...rows], new Set());
    expect(r.fresh).toHaveLength(rows.length);
    expect(r.duplicates).toBe(rows.length);
  });

  it('keeps two genuinely identical-looking payments on different days', () => {
    const a = fingerprint('2026-04-01', 45_000, 'SWIGGY');
    const b = fingerprint('2026-04-02', 45_000, 'SWIGGY');
    expect(a).not.toBe(b);
  });

  it('ignores punctuation and case when matching', () => {
    expect(fingerprint('2026-04-01', 45_000, 'UPI-SWIGGY ORDER')).toBe(
      fingerprint('2026-04-01', 45_000, 'upi swiggy order'),
    );
  });
});
