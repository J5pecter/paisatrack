/**
 * Turning the text of a statement into transactions.
 *
 * Pure: text in, data out. No PDF reader, no DOM, no database — the extraction
 * step upstream hands this an array of lines and it hands back candidates for
 * the user to review.
 *
 * **Nothing here writes anything.** Every row produced is a proposal. Silently
 * importing a misread row into someone's finances is worse than importing
 * nothing, so the pipeline always ends at a review screen.
 *
 * The hard problem is that no two Indian banks lay a statement out the same
 * way, and several change layout between the summary and the transaction table
 * of the same document. Rather than maintain a parser per bank, this reads the
 * structure every statement shares — a date, a description, an amount, usually
 * a running balance — and leans on the balance column for the one thing
 * keywords get wrong.
 */
import type { ExpenseCategory, ISODate, Paise } from '@/types';
import { directionFromText, findAmounts, findDate, squash } from './tokens';

export type StatementKind = 'BANK' | 'CARD' | 'UPI' | 'CAS' | 'UNKNOWN';

export interface ParsedTxn {
  date: ISODate;
  description: string;
  /** Always the magnitude. Direction is carried separately. */
  amount: Paise;
  direction: 'DEBIT' | 'CREDIT';
  /** The running balance on that row, when the statement prints one. */
  balance?: Paise;
  category: ExpenseCategory;
  /**
   * How the direction was decided, surfaced in the review UI so a user can see
   * which rows were inferred rather than read.
   */
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** Stable identity for de-duplicating against what is already stored. */
  fingerprint: string;
}

export interface ExtractResult {
  transactions: ParsedTxn[];
  /** Lines that looked like transactions but could not be read. */
  skipped: number;
  warnings: string[];
}

/**
 * Merchant keywords to categories.
 *
 * A first guess only — every row is editable in review. Ordered most specific
 * first, because "swiggy instamart" is groceries while plain "swiggy" is food.
 */
const CATEGORY_HINTS: Array<[RegExp, ExpenseCategory]> = [
  [/instamart|blinkit|zepto|bigbasket|dmart|grofers|jiomart|more retail|reliance fresh/i, 'GROCERIES'],
  [/swiggy|zomato|dominos|mcdonald|kfc|starbucks|cafe|restaurant|eatery|dunzo/i, 'FOOD'],
  [/uber|ola|rapido|metro|irctc|redbus|namma yatri|blusmart/i, 'TRANSPORT'],
  [/indian oil|bharat petro|hp petrol|iocl|bpcl|hpcl|fuel|petrol pump/i, 'FUEL'],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq|snapdeal/i, 'SHOPPING'],
  [/netflix|spotify|hotstar|prime video|bookmyshow|pvr|inox|jiocinema|sonyliv/i, 'ENTERTAINMENT'],
  [/apollo|pharmeasy|1mg|netmeds|hospital|clinic|diagnost|medical|pharmacy/i, 'HEALTH'],
  [/udemy|coursera|byju|unacademy|vedantu|tuition|school fee|college/i, 'EDUCATION'],
  [/makemytrip|goibibo|cleartrip|yatra|airbnb|oyo|indigo|vistara|air india|spicejet/i, 'TRAVEL'],
  [/salon|barber|spa|grooming|beauty/i, 'PERSONAL_CARE'],
  [/electricity|bescom|msedcl|tneb|water bill|gas bill|broadband|airtel|jio|vodafone|vi postpaid|act fibernet|tata play|dth/i, 'BILLS'],
  [/rent|landlord|nobroker|house rent/i, 'RENT'],
  [/emi|loan repay|instal?ment/i, 'EMI'],
  [/sip|mutual fund|zerodha|groww|upstox|kuvera|coin |nps |ppf |elss/i, 'INVESTMENT'],
  [/charge|fee|gst|penalty|annual fee|late fee|surcharge/i, 'FEES'],
];

/** First guess at a category from the narration. Always user-editable. */
export function guessCategory(description: string): ExpenseCategory {
  for (const [re, category] of CATEGORY_HINTS) {
    if (re.test(description)) return category;
  }
  return 'OTHER';
}

/**
 * A stable identity for a transaction.
 *
 * Date, magnitude and a normalised description. Deliberately excludes the
 * running balance: re-importing an overlapping date range is the common case,
 * and the balance can legitimately differ between two statements covering the
 * same row.
 */
export function fingerprint(date: ISODate, amount: Paise, description: string): string {
  const key = description.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  return `${date}|${amount}|${key}`;
}

/**
 * Strip the date and amounts out of a line, leaving the narration.
 *
 * Cutting by index alone is not enough. Reference numbers are appended
 * straight onto the merchant with a hyphen ("ORDER-9876543210"), so they are
 * not separate tokens, and removing an amount by index can leave a stray digit
 * behind when the matched span and the printed number disagree by a character.
 * Both are cleaned up afterwards by shape rather than by position.
 */
function narration(line: string, cuts: Array<{ index: number; length: number }>): string {
  let out = line;
  // Right to left so earlier indices stay valid.
  for (const cut of [...cuts].sort((a, b) => b.index - a.index)) {
    out = out.slice(0, cut.index) + ' ' + out.slice(cut.index + cut.length);
  }

  return squash(out)
    // Labelled references: "Ref No: 12345678".
    .replace(/\b(ref|txn|utr|rrn|chq|order)\s*(no\.?|#)?\s*[:.]?\s*\w{6,}/gi, ' ')
    // Bare reference runs, including ones welded onto a merchant name. Six
    // digits is long enough that no meaningful part of a narration is lost.
    .replace(/\d{6,}/g, ' ')
    // Whatever a cut left behind: a lone digit or orphaned punctuation.
    .replace(/(^|\s)[\d.,|/-]{1,2}(?=\s|$)/g, ' ')
    .replace(/[\s\-|/]+$/, '')
    .replace(/^[\s\-|/]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface Row {
  date: ISODate;
  text: string;
  amounts: Array<{ value: Paise; raw: string; index: number }>;
  dateCut: { index: number; length: number };
}

/**
 * Decide direction from how the running balance moved.
 *
 * This is the whole trick. Keywords are unreliable — "payment" appears on both
 * sides, and plenty of rows carry no marker at all — but a balance that went
 * down is money that left, with no ambiguity. It also validates the amount: if
 * the balance moved by exactly the candidate amount, the row was read right.
 *
 * Returns null when there is no usable balance pair, and the caller falls back.
 */
function directionFromBalance(previous: Paise | undefined, current: Paise | undefined, amount: Paise) {
  if (previous === undefined || current === undefined) return null;
  const delta = current - previous;
  if (delta === 0) return null;
  // Tolerate a paisa of rounding between what is printed and what is summed.
  if (Math.abs(Math.abs(delta) - amount) > 1) return null;
  return delta < 0 ? ('DEBIT' as const) : ('CREDIT' as const);
}

/**
 * Read transactions out of the lines of a statement.
 *
 * `kind` only shifts the defaults: on a credit card statement an unmarked row
 * is a purchase (money owed), where on a bank statement it is ambiguous.
 */
export function extractTransactions(lines: string[], kind: StatementKind = 'BANK'): ExtractResult {
  const warnings: string[] = [];
  let skipped = 0;

  // Pass 1: every line that carries a date and at least one amount.
  //
  // Scanned on the ORIGINAL line, not a whitespace-collapsed one. Most Indian
  // bank statements print separate withdrawal and deposit columns, and which
  // column an amount sits in is the clearest evidence of direction there is —
  // but it lives entirely in the horizontal padding, which squashing destroys.
  const rows: Row[] = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;

    const amounts = findAmounts(raw);
    if (amounts.length === 0) continue;

    const found = findDate(raw);
    if (!found) {
      // Amounts but no date: a summary or carried-over line, not a transaction.
      continue;
    }

    rows.push({
      date: found.date,
      text: raw,
      amounts,
      dateCut: { index: found.index, length: found.raw.length },
    });
  }

  // Pass 2: where a balance column exists, the last amount on every row is it.
  // Checked across rows rather than assumed, because a statement without a
  // balance column would otherwise have its last amount eaten.
  const looksLikeBalanceColumn =
    rows.length >= 3 &&
    rows.filter((r) => r.amounts.length >= 2).length >= Math.ceil(rows.length * 0.8);

  /**
   * Where the transaction amounts sit horizontally.
   *
   * A statement with separate withdrawal and deposit columns puts every debit
   * at roughly one x-position and every credit at another. If the positions
   * fall into two clearly separated groups, the left one is money out — which
   * is both the convention and the only reading that matches the balances.
   *
   * This is the signal that rescues the first row of a statement: there is no
   * previous balance to compare it against, but its column is right there.
   */
  const columnSplit = (() => {
    const positions = rows
      .map((r) => {
        const amounts = looksLikeBalanceColumn && r.amounts.length >= 2 ? r.amounts.slice(0, -1) : r.amounts;
        return amounts[amounts.length - 1]?.index;
      })
      .filter((i): i is number => i !== undefined)
      .sort((a, b) => a - b);

    if (positions.length < 3) return null;

    // Widest gap between consecutive positions. Two real columns are separated
    // by far more than the jitter within one column, which comes only from
    // amounts of differing length being right-aligned.
    let bestGap = 0;
    let splitAt = 0;
    for (let i = 1; i < positions.length; i++) {
      const gap = positions[i] - positions[i - 1];
      if (gap > bestGap) {
        bestGap = gap;
        splitAt = (positions[i] + positions[i - 1]) / 2;
      }
    }
    // Under ~12 characters this is one column with ragged alignment, not two.
    return bestGap >= 12 ? splitAt : null;
  })();

  const transactions: ParsedTxn[] = [];
  let previousBalance: Paise | undefined;

  for (const row of rows) {
    const balance = looksLikeBalanceColumn && row.amounts.length >= 2
      ? row.amounts[row.amounts.length - 1].value
      : undefined;

    // The transaction amount is the last non-balance figure. Where a statement
    // prints separate debit and credit columns, one of them is blank and the
    // remaining value is the one that matters either way.
    const candidates = balance !== undefined ? row.amounts.slice(0, -1) : row.amounts;
    const amountToken = candidates[candidates.length - 1];

    if (!amountToken || amountToken.value === 0) {
      skipped++;
      continue;
    }

    const amount = Math.abs(amountToken.value);

    const byBalance = directionFromBalance(previousBalance, balance, amount);
    const byText = directionFromText(row.text);
    const byColumn =
      columnSplit === null ? null : amountToken.index < columnSplit ? ('DEBIT' as const) : ('CREDIT' as const);

    let direction: 'DEBIT' | 'CREDIT';
    let confidence: ParsedTxn['confidence'];

    if (byBalance) {
      // The statement's own arithmetic agrees with the amount we read.
      direction = byBalance;
      confidence = 'HIGH';
    } else if (byColumn) {
      // Which column it was printed in. Reliable enough to stand alone, and it
      // is the only evidence available for the first row of a statement.
      direction = byColumn;
      confidence = 'HIGH';
    } else if (byText) {
      direction = byText;
      confidence = 'MEDIUM';
    } else if (amountToken.value < 0) {
      direction = 'DEBIT';
      confidence = 'MEDIUM';
    } else {
      // Nothing to go on. A card statement's default is a purchase; a bank
      // statement's is not knowable, so it is flagged for the reviewer.
      direction = 'DEBIT';
      confidence = kind === 'CARD' ? 'MEDIUM' : 'LOW';
    }

    const description =
      narration(row.text, [row.dateCut, ...row.amounts.map((a) => ({ index: a.index, length: a.raw.length }))]) ||
      'Unlabelled transaction';

    transactions.push({
      date: row.date,
      description,
      amount,
      direction,
      balance,
      category: direction === 'CREDIT' ? 'OTHER' : guessCategory(description),
      confidence,
      fingerprint: fingerprint(row.date, amount, description),
    });

    if (balance !== undefined) previousBalance = balance;
  }

  const lowConfidence = transactions.filter((t) => t.confidence === 'LOW').length;
  if (lowConfidence > 0) {
    warnings.push(
      `${lowConfidence} row${lowConfidence === 1 ? '' : 's'} had no debit/credit marker and no usable balance — check the direction before importing.`,
    );
  }
  if (skipped > 0) {
    warnings.push(`${skipped} line${skipped === 1 ? '' : 's'} looked like transactions but could not be read.`);
  }

  return { transactions, skipped, warnings };
}

/**
 * Drop rows already present, by fingerprint.
 *
 * Re-importing an overlapping period is the normal way people use this —
 * last month's statement and this month's will share rows — so the pipeline
 * has to be safe to run twice.
 */
export function dedupe(candidates: ParsedTxn[], existing: Set<string>): {
  fresh: ParsedTxn[];
  duplicates: number;
} {
  const fresh: ParsedTxn[] = [];
  const seen = new Set(existing);
  let duplicates = 0;

  for (const t of candidates) {
    if (seen.has(t.fingerprint)) {
      duplicates++;
      continue;
    }
    seen.add(t.fingerprint);
    fresh.push(t);
  }
  return { fresh, duplicates };
}
