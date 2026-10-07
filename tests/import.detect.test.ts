/**
 * Recognising what a document is, and reading a CAS.
 *
 * Detection matters because it sets the defaults the rest of the pipeline uses
 * — an unmarked row on a credit card statement is a purchase, where the same
 * row on a bank statement is genuinely ambiguous. Getting the document type
 * wrong would make every row in it wrong in the same direction.
 */
import { describe, expect, it } from 'vitest';
import { detectPeriod, detectStatement, parseCas } from '@/lib/import/detect';

describe('detectStatement', () => {
  it('recognises a bank statement', () => {
    const d = detectStatement([
      'HDFC BANK LTD',
      'Statement of Account',
      'Opening Balance 50,000.00',
      'Withdrawal Deposit Closing Balance',
    ]);
    expect(d.kind).toBe('BANK');
    expect(d.source).toMatch(/Hdfc/i);
  });

  it('recognises a credit card statement by its minimum due', () => {
    // The one line a card statement always has and a bank statement never does.
    const d = detectStatement([
      'ICICI Bank Credit Card Statement',
      'Total Amount Due 24,500.00',
      'Minimum Amount Due 1,225.00',
      'Payment Due Date 05/05/2026',
    ]);
    expect(d.kind).toBe('CARD');
  });

  it('recognises each UPI app', () => {
    expect(detectStatement(['PhonePe Transaction Statement']).kind).toBe('UPI');
    expect(detectStatement(['PhonePe Transaction Statement']).source).toBe('PhonePe');
    expect(detectStatement(['Google Pay transaction history']).source).toBe('Google Pay');
    expect(detectStatement(['Paytm Wallet Statement']).source).toBe('Paytm');
  });

  it('recognises a mutual fund CAS', () => {
    const d = detectStatement([
      'Consolidated Account Statement',
      'CAMS / KFintech',
      'Folio No: 12345678 / 90',
      'HDFC Flexi Cap Fund - Growth',
    ]);
    expect(d.kind).toBe('CAS');
  });

  it('recognises a depository holding statement', () => {
    const d = detectStatement([
      'NSDL Consolidated Account Statement',
      'Demat Account Holdings',
      'ISIN INE002A01018',
    ]);
    expect(d.kind).toBe('CAS');
    expect(d.source).toMatch(/NSDL/);
  });

  it('says UNKNOWN rather than guessing at an unrecognised document', () => {
    // The generic extractor still runs; it just does not pretend to know the
    // document's conventions.
    expect(detectStatement(['Some random PDF', 'with no financial wording']).kind).toBe('UNKNOWN');
  });

  it('prefers card over bank when a card statement names its bank', () => {
    const d = detectStatement([
      'HDFC Bank Credit Card Statement',
      'Closing Balance 10,000',
      'Minimum Amount Due 500.00',
    ]);
    expect(d.kind).toBe('CARD');
  });
});

describe('parseCas', () => {
  const CAMS = `
Consolidated Account Statement
Folio No: 12345678 / 90
HDFC Flexi Cap Fund - Growth Plan INF179K01BE2
Closing Unit Balance: 1,234.567
Total Amount Invested: INR 2,40,000.00
Market Value on 31-Mar-2026: INR 2,91,500.00
Folio No: 99887766
Parag Parikh Flexi Cap Fund - Direct Growth INF879O01027
Closing Unit Balance: 456.789
Market Value on 31-Mar-2026: INR 1,52,345.67
`.trim().split('\n');

  const r = parseCas(CAMS);

  it('reads every scheme in the statement', () => {
    expect(r.holdings).toHaveLength(2);
  });

  it('reads the market value in paise', () => {
    expect(r.holdings[0].currentValue).toBe(2_91_500_00);
    expect(r.holdings[1].currentValue).toBe(1_52_345_67);
  });

  it('reads units and the amount invested when the statement reports them', () => {
    expect(r.holdings[0].units).toBeCloseTo(1234.567, 3);
    expect(r.holdings[0].invested).toBe(2_40_000_00);
  });

  it('does not invent an invested figure the statement did not print', () => {
    // The second scheme has no "Total Amount Invested" line. Reporting a
    // gain against a made-up cost base would be worse than reporting none.
    expect(r.holdings[1].invested).toBeUndefined();
  });

  it('captures the folio and the ISIN', () => {
    expect(r.holdings[0].folio).toBe('12345678');
    expect(r.holdings[0].isin).toBe('INF179K01BE2');
  });

  it('classifies by ISIN prefix — INF is a fund, INE is listed equity', () => {
    expect(r.holdings[0].kind).toBe('MUTUAL_FUND');
    const equity = parseCas([
      'Reliance Industries Limited INE002A01018',
      'Market Value: INR 1,00,000.00',
    ]);
    expect(equity.holdings[0]?.kind).toBe('EQUITY');
  });

  it('warns rather than failing silently on an unrecognised layout', () => {
    const r2 = parseCas(['Some statement', 'with nothing recognisable']);
    expect(r2.holdings).toEqual([]);
    expect(r2.warnings.join(' ')).toMatch(/layouts differ/i);
  });
});

describe('detectPeriod', () => {
  it('reads the statement period', () => {
    expect(
      detectPeriod(['Statement Period: 01/04/2026 to 30/04/2026']),
    ).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('returns null when no period is stated', () => {
    expect(detectPeriod(['Statement of Account'])).toBeNull();
  });

  it('rejects a reversed range rather than returning nonsense', () => {
    expect(detectPeriod(['From 30/04/2026 to 01/04/2026'])).toBeNull();
  });
});
