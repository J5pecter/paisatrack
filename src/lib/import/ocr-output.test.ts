/**
 * What the extractor must do with OCR output.
 *
 * The lines below are not invented. They are the literal output of
 * tesseract.js reading a rendered bank statement, captured from the running
 * app, and they encode the single most important thing to know about reading a
 * scan:
 *
 *   **Tesseract collapses runs of whitespace.**
 *
 * A statement PDF with a text layer is rebuilt by `pdf.ts` as fixed-width text
 * so that column positions survive, because which column an amount sits in is
 * the clearest statement of whether it is a debit or a credit. OCR destroys
 * that. `'...SALARY CREDIT APRIL                85,000.00   85,000.00'` comes
 * back as `'...SALARY CREDIT APRIL 85,000.00 85,000.00'`, and no amount of page
 * segmentation mode changes it.
 *
 * Direction detection survives anyway, and these tests exist to prove it stays
 * surviving. The running-balance check is arithmetic, not positional: if the
 * previous balance minus this amount equals this balance, it was a debit, and
 * that holds however the spacing is mangled. It is the reason the balance
 * signal is ranked above the column signal in `statement.ts` rather than the
 * other way around — a decision that looks arbitrary until you read a scan.
 *
 * If someone "simplifies" the direction hierarchy by leading with the column
 * heuristic, every one of these assertions fails.
 */
import { describe, expect, it } from 'vitest';
import { extractTransactions } from './statement';

/** Literal tesseract.js output. Do not reformat — the spacing is the point. */
const OCR_LINES = [
  'HDFC BANK STATEMENT OF ACCOUNT',
  'Date Narration Withdrawal Deposit Balance',
  '01/04/2026 SALARY CREDIT APRIL 85,000.00 85,000.00',
  '03/04/2026 UPI-SWIGGY-BANGALORE 642.00 84,358.00',
  '07/04/2026 NEFT RENT PAYMENT 22,000.00 62,358.00',
  '12/04/2026 ATM CASH WITHDRAWAL 5,000.00 57,358.00',
];

describe('extractTransactions on OCR output', () => {
  const result = extractTransactions(OCR_LINES, 'BANK');
  const [salary, swiggy, rent, atm] = result.transactions;

  it('reads every transaction row and no header rows', () => {
    expect(result.transactions).toHaveLength(4);
  });

  it('separates the amount from the running balance', () => {
    // The hard part: each row ends in two numbers and only one is the
    // transaction. Taking the last would import the balance as a payment.
    expect(swiggy.amount).toBe(64200); // ₹642.00
    expect(swiggy.balance).toBe(8435800); // ₹84,358.00
    expect(rent.amount).toBe(2200000);
    expect(atm.amount).toBe(500000);
  });

  it('derives direction from the balance, which whitespace collapse cannot touch', () => {
    // 85,000.00 − 642.00 = 84,358.00. The statement's own arithmetic agrees,
    // so this is HIGH even though it came off a scan with no column layout.
    expect(swiggy.direction).toBe('DEBIT');
    expect(swiggy.confidence).toBe('HIGH');
    expect(rent.direction).toBe('DEBIT');
    expect(rent.confidence).toBe('HIGH');
    expect(atm.direction).toBe('DEBIT');
    expect(atm.confidence).toBe('HIGH');
  });

  it('falls back to the wording for the first row, which has no previous balance', () => {
    // Nothing to subtract from yet, so the only evidence is the word "CREDIT"
    // in the narration — right answer, lower confidence, correctly labelled.
    expect(salary.direction).toBe('CREDIT');
    expect(salary.confidence).toBe('MEDIUM');
  });

  it('does not claim rows were unreadable when they were not', () => {
    // The "no debit/credit marker and no usable balance" warning must not fire
    // here. Three rows had a usable balance and the fourth had a marker.
    expect(result.warnings).toEqual([]);
  });

  it('keeps the narration free of the figures around it', () => {
    expect(salary.description).toBe('SALARY CREDIT APRIL');
    expect(swiggy.description).toBe('UPI-SWIGGY-BANGALORE');
    expect(atm.description).toBe('ATM CASH WITHDRAWAL');
  });

  it('categorises from the narration', () => {
    expect(swiggy.category).toBe('FOOD');
    expect(rent.category).toBe('RENT');
  });
});
