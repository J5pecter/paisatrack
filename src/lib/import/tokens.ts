/**
 * Reading the two things every Indian statement is made of: dates and amounts.
 *
 * Pure functions over strings, like everything else in the finance layer. No
 * PDF, no DOM — the extraction step hands these plain text and they hand back
 * plain data, which is what makes the parsers testable without a browser.
 *
 * Every bank formats these differently and several change format between the
 * summary and the transaction table of the *same* document, so these are
 * deliberately permissive readers rather than strict validators. Anything they
 * cannot read returns null and the caller decides what that means.
 */
import type { ISODate, Paise } from '@/types';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Does this YYYY-MM-DD name a day that exists? Shared with validation.ts. */
function isRealDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): ISODate | null {
  if (!isRealDate(y, m, d)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Two-digit years.
 *
 * A statement is a record of something that already happened, so a year that
 * would land in the future is read as the previous century. "25" is 2025;
 * "99" is 1999, not 2099.
 */
function expandYear(raw: number): number {
  if (raw > 99) return raw;
  const full = 2000 + raw;
  return full > new Date().getFullYear() + 1 ? 1900 + raw : full;
}

/**
 * Read a date in any of the shapes Indian statements use.
 *
 * Handles DD/MM/YYYY, DD-MM-YY, DD-MMM-YYYY, "15 Mar 2026", "Mar 15, 2026" and
 * ISO. **Day-first is assumed** for all-numeric dates, because that is the
 * Indian convention — an American reading of 03/04/2026 would silently shift a
 * transaction by a month, and silently wrong is the worst outcome here.
 */
export function parseLooseDate(input: string): ISODate | null {
  const s = input.trim();
  if (!s) return null;

  // ISO first: unambiguous, so it never reaches the day-first assumption.
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (isoMatch) {
    return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // DD/MM/YYYY, DD-MM-YY, DD.MM.YYYY
  const numeric = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
  if (numeric) {
    return iso(expandYear(Number(numeric[3])), Number(numeric[2]), Number(numeric[1]));
  }

  // DD-MMM-YYYY, "15 Mar 2026", "15-March-26"
  const dayFirst = /^(\d{1,2})[\s\-/]*([A-Za-z]{3,9})[\s\-/,]*(\d{2,4})$/.exec(s);
  if (dayFirst) {
    const m = MONTHS[dayFirst[2].toLowerCase().slice(0, 4)] ?? MONTHS[dayFirst[2].toLowerCase().slice(0, 3)];
    if (m) return iso(expandYear(Number(dayFirst[3])), m, Number(dayFirst[1]));
  }

  // "Mar 15, 2026" — the shape the UPI apps use.
  const monthFirst = /^([A-Za-z]{3,9})[\s\-/]*(\d{1,2})[\s,\-/]*(\d{2,4})$/.exec(s);
  if (monthFirst) {
    const m = MONTHS[monthFirst[1].toLowerCase().slice(0, 4)] ?? MONTHS[monthFirst[1].toLowerCase().slice(0, 3)];
    if (m) return iso(expandYear(Number(monthFirst[3])), m, Number(monthFirst[2]));
  }

  return null;
}

/** Every date-shaped run of characters, so a line can be scanned for one. */
const DATE_PATTERN =
  /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{1,2}[\s-]?[A-Za-z]{3,9}[\s,-]?\d{2,4}|[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{2,4})\b/g;

/** The first readable date on a line, with where it was found. */
export function findDate(line: string): { date: ISODate; raw: string; index: number } | null {
  DATE_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_PATTERN.exec(line)) !== null) {
    const date = parseLooseDate(m[1]);
    if (date) return { date, raw: m[1], index: m.index };
  }
  return null;
}

/**
 * Read a rupee amount into integer paise.
 *
 * Copes with the Indian grouping (1,23,456.78), a rupee sign, spaces, and the
 * accounting convention of wrapping a negative in brackets. Returns null rather
 * than 0 for unreadable input: a statement line that should carry an amount and
 * does not is a parse failure worth surfacing, and 0 would hide it.
 */
export function parseIndianAmount(input: string): Paise | null {
  let s = input.trim();
  if (!s) return null;

  const bracketed = /^\((.*)\)$/.exec(s);
  if (bracketed) s = `-${bracketed[1]}`;

  s = s.replace(/[₹\s]/g, '').replace(/,/g, '').replace(/INR/gi, '');

  // Trailing Dr/Cr markers are direction, not part of the number.
  s = s.replace(/(dr|cr)\.?$/i, '');

  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;

  const rupees = Number(s);
  if (!Number.isFinite(rupees)) return null;

  // Round rather than truncate: 0.1 + 0.2 arithmetic means a value read as
  // 123.449999 must still land on 12345 paise.
  return Math.round(rupees * 100);
}

/** Every amount-shaped token on a line, left to right, with positions. */
export function findAmounts(line: string): Array<{ value: Paise; raw: string; index: number }> {
  const out: Array<{ value: Paise; raw: string; index: number }> = [];
  // Requires either a decimal part or a grouping comma, so bare integers like
  // a reference number or a year are not mistaken for money.
  const re = /(?:₹|INR)?\s?\(?-?(?:\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2})\)?\s?(?:Dr|Cr)?\.?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const value = parseIndianAmount(m[0]);
    if (value !== null) out.push({ value, raw: m[0].trim(), index: m.index });
  }
  return out;
}

/**
 * Which way did the money go?
 *
 * Checked in order of how much the statement is actually telling us:
 *   1. An explicit Dr/Cr or Debit/Credit marker on the line.
 *   2. The direction words the UPI apps use ("Paid to", "Received from").
 *   3. Nothing — the caller falls back to the running balance, which is the
 *      most reliable signal of all but needs the previous row to compare.
 */
export function directionFromText(line: string): 'DEBIT' | 'CREDIT' | null {
  const s = line.toLowerCase();

  if (/\bcr\.?\b|\bcredit\b|received from|refund|cashback|money added|deposited\b/.test(s)) {
    return 'CREDIT';
  }
  if (/\bdr\.?\b|\bdebit\b|paid to|sent to|withdrawn|purchase\b/.test(s)) {
    return 'DEBIT';
  }
  return null;
}

/** Collapse runs of whitespace so extracted PDF text compares predictably. */
export function squash(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}
