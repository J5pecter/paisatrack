/**
 * Spreadsheet statements, and the CAS transaction history.
 *
 * The format sniffing matters more than it looks. Half the ".xls" files Indian
 * banks hand out are HTML tables — Excel opens them, every real XLSX parser
 * rejects them, and trusting the extension would mean telling the user their
 * perfectly good statement is corrupt.
 */
import { describe, expect, it } from 'vitest';
import { columnIndex, gridToLines, readHtmlTable, sniffFormat } from '@/lib/import/spreadsheet';
import { parseCas } from '@/lib/import/detect';
import { extractTransactions } from '@/lib/import/statement';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('sniffFormat', () => {
  it('recognises a real XLSX by its ZIP magic', () => {
    expect(sniffFormat(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('XLSX');
  });

  it('recognises the HTML table that banks mislabel as .xls', () => {
    // HDFC and ICICI both do this. The extension says xls; the bytes say HTML.
    expect(sniffFormat(bytes('<html><body><table><tr><td>Date</td></tr>'))).toBe('HTML_TABLE');
    expect(sniffFormat(bytes('<!DOCTYPE html><table>'))).toBe('HTML_TABLE');
  });

  it('recognises a delimited file', () => {
    expect(sniffFormat(bytes('Date,Narration,Amount\n01/04/2026,X,100'))).toBe('DELIMITED');
  });

  it('refuses the old binary .xls rather than producing nonsense', () => {
    // A BIFF compound document. Not supported, and saying so beats emitting
    // garbage rows the user then has to spot.
    expect(sniffFormat(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('UNKNOWN');
  });

  it('decides by content, never by name', () => {
    // The whole point: these bytes would be called "statement.xls" by the bank.
    expect(sniffFormat(bytes('<table><tr><td>x</td></tr></table>'))).toBe('HTML_TABLE');
  });
});

describe('columnIndex', () => {
  it('reads spreadsheet column letters', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('B2')).toBe(1);
    expect(columnIndex('Z9')).toBe(25);
    // Base-26 with no zero, so AA follows Z.
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('BC12')).toBe(54);
  });
});

describe('gridToLines', () => {
  it('pads cells so columns stay at stable offsets', () => {
    // Direction is read from which column an amount sits in, so the padding is
    // load-bearing rather than cosmetic.
    const lines = gridToLines([
      ['01/04/2026', 'SWIGGY', '450.00', '', '50,000.00'],
      ['05/04/2026', 'SALARY', '', '85,000.00', '1,35,000.00'],
    ]);
    const firstAmount = lines[0].indexOf('450.00');
    const creditAmount = lines[1].indexOf('85,000.00');
    expect(creditAmount).toBeGreaterThan(firstAmount + 10);
  });

  it('drops entirely blank rows', () => {
    expect(gridToLines([['', '', ''], ['01/04/2026', 'X', '1.00']])).toHaveLength(1);
  });
});

describe('an HTML-table statement, end to end', () => {
  const html = `
    <html><body><table>
      <tr><th>Date</th><th>Narration</th><th>Withdrawal</th><th>Deposit</th><th>Balance</th></tr>
      <tr><td>01/04/2026</td><td>UPI-SWIGGY</td><td>450.00</td><td></td><td>50,000.00</td></tr>
      <tr><td>03/04/2026</td><td>UPI-BLINKIT</td><td>1,250.00</td><td></td><td>48,750.00</td></tr>
      <tr><td>05/04/2026</td><td>SALARY APR</td><td></td><td>85,000.00</td><td>1,33,750.00</td></tr>
    </table></body></html>`;

  it('reads the rows out of the table', () => {
    expect(readHtmlTable(html)).toHaveLength(4); // header + 3
  });

  it('feeds the same extractor and gets the directions right', () => {
    // The point of converting to padded lines: one set of rules for direction
    // and categories, whether the statement arrived as PDF, CSV or a table.
    const r = extractTransactions(gridToLines(readHtmlTable(html)), 'BANK');
    expect(r.transactions).toHaveLength(3);
    expect(r.transactions[2].direction).toBe('CREDIT');
    expect(r.transactions[2].amount).toBe(85_000_00);
    expect(r.transactions[0].category).toBe('FOOD');
  });

  it('reads text only — a hostile file cannot execute anything', () => {
    // Parsed with DOMParser and read via textContent; nothing is inserted into
    // the live document.
    const grid = readHtmlTable('<table><tr><td><img src=x onerror="alert(1)">7</td></tr></table>');
    expect(grid[0][0]).toBe('7');
  });
});

describe('CAS transaction history', () => {
  const CAS = `
Consolidated Account Statement
Folio No: 12345678 / 90
HDFC Flexi Cap Fund - Growth Plan INF179K01BE2
05-Apr-2026 Systematic Investment Purchase 10,000.00 8.456 1,182.45
05-May-2026 Systematic Investment Purchase 10,000.00 8.201 1,219.32
12-Jun-2026 Redemption 25,000.00 20.110 1,243.16
30-Jun-2026 Stamp Duty 0.50
Closing Unit Balance: 1,234.567
Market Value on 30-Jun-2026: INR 2,91,500.00
`.trim().split('\n');

  const r = parseCas(CAS);

  it('reads the dated movements, not just the holding', () => {
    expect(r.transactions).toHaveLength(3);
    expect(r.holdings).toHaveLength(1);
  });

  it('classifies each movement', () => {
    // An SIP instalment is also a purchase; the specific reading is the useful
    // one, so ordering in the classifier matters.
    expect(r.transactions[0].kind).toBe('SIP');
    expect(r.transactions[2].kind).toBe('REDEMPTION');
  });

  it('reads the amount in paise and the units', () => {
    expect(r.transactions[0].amount).toBe(10_000_00);
    expect(r.transactions[0].units).toBeCloseTo(8.456, 3);
  });

  it('attributes each movement to its scheme and folio', () => {
    expect(r.transactions[0].scheme).toMatch(/HDFC Flexi Cap/);
    expect(r.transactions[0].folio).toBe('12345678');
  });

  it('ignores a stamp duty line, which is a fee on the row above', () => {
    // Counting it as an investment would overstate what was put in.
    expect(r.transactions.some((t) => /stamp/i.test(t.description))).toBe(false);
  });

  it('still reads the holding alongside the history', () => {
    expect(r.holdings[0].currentValue).toBe(2_91_500_00);
    expect(r.holdings[0].units).toBeCloseTo(1234.567, 3);
  });
});
