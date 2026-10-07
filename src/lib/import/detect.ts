/**
 * Working out what kind of document this is, and reading the ones that are not
 * simply lists of transactions.
 *
 * Pure: text in, data out.
 */
import type { Paise } from '@/types';
import { findAmounts, parseIndianAmount, parseLooseDate, squash } from './tokens';
import type { StatementKind } from './statement';

export interface Detection {
  kind: StatementKind;
  /** What to show the user: "HDFC Bank", "PhonePe", "CAMS consolidated statement". */
  source: string;
}

/**
 * Identify the document from its own wording.
 *
 * Checked most specific first. A CAS mentions both "mutual fund" and a folio
 * number; a credit card statement mentions a minimum amount due; a bank
 * statement mentions a closing balance. Where nothing matches, the generic
 * transaction extractor still runs — it just cannot set sensible defaults.
 */
export function detectStatement(lines: string[]): Detection {
  const text = lines.join('\n').toLowerCase();

  const bank = /hdfc|icici|state bank|sbi|axis bank|kotak|yes bank|idfc|indusind|punjab national|bank of baroda|canara|union bank/.exec(text);
  const brand = (name: string) => name.replace(/\b\w/g, (c) => c.toUpperCase());

  // Consolidated Account Statement — CAMS or KFintech, covering mutual funds.
  if (/consolidated account statement|cams|kfintech|karvy/.test(text) && /folio\s*(no|number)/.test(text)) {
    return { kind: 'CAS', source: /kfintech|karvy/.test(text) ? 'KFintech CAS' : 'CAMS CAS' };
  }

  // NSDL/CDSL demat holding statements use the same CAS wrapper.
  if (/nsdl|cdsl/.test(text) && /(demat|holding|isin)/.test(text)) {
    return { kind: 'CAS', source: /nsdl/.test(text) ? 'NSDL CAS' : 'CDSL CAS' };
  }

  if (/phonepe/.test(text)) return { kind: 'UPI', source: 'PhonePe' };
  if (/google pay|gpay|g-pay/.test(text)) return { kind: 'UPI', source: 'Google Pay' };
  if (/paytm/.test(text)) return { kind: 'UPI', source: 'Paytm' };

  // A credit card statement always states a minimum due; a bank statement never does.
  if (/minimum amount due|minimum due|total amount due|credit card statement|payment due date/.test(text)) {
    return { kind: 'CARD', source: bank ? `${brand(bank[0])} credit card` : 'Credit card' };
  }

  if (/closing balance|opening balance|statement of account|account statement|withdrawal|deposit/.test(text)) {
    return { kind: 'BANK', source: bank ? `${brand(bank[0])} account` : 'Bank account' };
  }

  return { kind: 'UNKNOWN', source: 'Statement' };
}

export interface ParsedHolding {
  name: string;
  kind: 'MUTUAL_FUND' | 'EQUITY';
  folio?: string;
  isin?: string;
  units?: number;
  /** Market value as at the statement date. */
  currentValue: Paise;
  /** What was put in, when the statement reports it. */
  invested?: Paise;
}

export type CasTxnKind = 'PURCHASE' | 'SIP' | 'REDEMPTION' | 'SWITCH' | 'DIVIDEND' | 'OTHER';

export interface CasTxn {
  date: string;
  /** The scheme the row belongs to, carried down from its block header. */
  scheme: string;
  folio?: string;
  kind: CasTxnKind;
  description: string;
  /** Rupees moved. Always a magnitude; `kind` carries the direction. */
  amount: Paise;
  units?: number;
  nav?: Paise;
}

export interface CasResult {
  holdings: ParsedHolding[];
  transactions: CasTxn[];
  warnings: string[];
}

/**
 * What kind of movement is this row?
 *
 * A CAS describes the same handful of events in wording that varies between
 * registrars and has drifted over the years, so this matches on the words that
 * have stayed put. Order matters: an SIP instalment is also a purchase, and
 * the more specific reading is the useful one.
 */
function classifyCasRow(text: string): CasTxnKind | null {
  const s = text.toLowerCase();

  // A stamp duty or STT line is a fee attached to the row above, not an event.
  if (/stamp duty|stt paid|transaction charge/.test(s)) return null;

  if (/systematic|sip\b/.test(s)) return 'SIP';
  if (/switch/.test(s)) return 'SWITCH';
  if (/dividend|idcw|payout/.test(s)) return 'DIVIDEND';
  if (/redemption|redeem|withdrawal/.test(s)) return 'REDEMPTION';
  if (/purchase|investment|subscription|allot/.test(s)) return 'PURCHASE';
  return null;
}

/**
 * Read holdings out of a consolidated account statement.
 *
 * A CAS prints one block per scheme: the name, a folio, then a closing balance
 * of units, the NAV, and a market value. The layout differs between CAMS and
 * KFintech and between versions, so this looks for the labelled values rather
 * than fixed positions — the labels have been stable for years where the
 * geometry has not.
 *
 * Reads both halves of the document in one pass: the holdings, and the dated
 * movements inside each scheme block. They are kept apart downstream because
 * they answer different questions — holdings are what you own now, the
 * movements are how you got there — and because a valuation row and a purchase
 * row look almost identical until you notice only one of them starts with a
 * date.
 */
export function parseCas(lines: string[]): CasResult {
  const holdings: ParsedHolding[] = [];
  const transactions: CasTxn[] = [];
  const warnings: string[] = [];

  let currentName: string | null = null;
  let currentFolio: string | undefined;
  let currentIsin: string | undefined;
  let units: number | undefined;
  let invested: Paise | undefined;

  const flush = (value: Paise) => {
    if (!currentName) return;
    holdings.push({
      name: squash(currentName).slice(0, 120),
      kind: currentIsin?.startsWith('INF') ? 'MUTUAL_FUND' : currentIsin ? 'EQUITY' : 'MUTUAL_FUND',
      folio: currentFolio,
      isin: currentIsin,
      units,
      currentValue: value,
      invested,
    });
    units = undefined;
    invested = undefined;
  };

  for (const raw of lines) {
    const line = squash(raw);
    if (!line) continue;

    const folio = /folio\s*(?:no\.?|number)?\s*[:.]?\s*([\w/-]+)/i.exec(line);
    if (folio) {
      currentFolio = folio[1];
      continue;
    }

    // ISINs are the one unambiguous identifier in the document. INF = mutual
    // fund, INE = listed equity.
    const isin = /\b(IN[EF][0-9A-Z]{9})\b/.exec(line);
    if (isin) {
      currentIsin = isin[1];
      // The scheme name usually shares the line with its ISIN.
      const name = line.replace(isin[0], '').replace(/[-–|]/g, ' ').trim();
      if (name.length > 6) currentName = name;
      continue;
    }

    // A scheme name: words, no date, and not a labelled figure.
    if (
      !/\d{2}[-/]\d{2}[-/]\d{2,4}/.test(line) &&
      /[A-Za-z]{6,}/.test(line) &&
      /fund|scheme|plan|growth|dividend|equity|debt|liquid|index/i.test(line) &&
      !/closing|opening|total|valuation|nav\b/i.test(line)
    ) {
      currentName = line;
      continue;
    }

    // A dated line inside a scheme block is a movement in that scheme.
    // Checked before the labelled-figure rules below, because a purchase row
    // also carries a NAV and would otherwise be read as a valuation.
    const dated = /^(\d{1,2}[-/][A-Za-z0-9]{2,9}[-/]\d{2,4})\s+(.*)$/.exec(line);
    if (dated && currentName) {
      const date = parseLooseDate(dated[1]);
      const kind = classifyCasRow(dated[2]);
      if (date && kind) {
        /*
          A CAS row prints amount, then units, then NAV, then a running unit
          balance — a known column order, so they are read positionally.

          Deliberately NOT via findAmounts. That reader is money-shaped: it
          matches two decimal places, so a unit count of 8.456 comes back as
          8.45 and the third decimal is silently lost. Units are not money and
          routinely carry three or four decimals.
        */
        const figures = dated[2].match(/\d[\d,]*\.\d+/g) ?? [];
        const amount = figures[0] ? parseIndianAmount(figures[0]) : null;
        const toNumber = (s: string | undefined) =>
          s === undefined ? undefined : Number(s.replace(/,/g, ''));

        if (amount !== null && amount !== 0) {
          transactions.push({
            date,
            scheme: squash(currentName).slice(0, 120),
            folio: currentFolio,
            kind,
            description: squash(dated[2].replace(/[\d,.\s]+$/, '')).slice(0, 120),
            amount: Math.abs(amount),
            units: toNumber(figures[1]),
            // NAV is money, so paise is the right unit — it rounds a
            // four-decimal NAV to the paisa, which nothing here computes with.
            nav: figures[2] ? (parseIndianAmount(figures[2]) ?? undefined) : undefined,
          });
        }
      }
      continue;
    }

    const unitMatch = /closing\s*(?:unit)?\s*balance\s*[:.]?\s*([\d,]+\.?\d*)/i.exec(line);
    if (unitMatch) {
      const n = Number(unitMatch[1].replace(/,/g, ''));
      if (Number.isFinite(n)) units = n;
    }

    const investedMatch = /(?:total\s*)?(?:amount\s*)?invested\s*[:.]?\s*(?:INR|₹)?\s*([\d,]+\.?\d*)/i.exec(line);
    if (investedMatch) invested = parseIndianAmount(investedMatch[1]) ?? undefined;

    // The market value closes a scheme block.
    const valueMatch = /(?:market|current)\s*value\s*(?:on[^:]*)?[:.]?\s*(?:INR|₹)?\s*([\d,]+\.?\d*)/i.exec(line);
    if (valueMatch) {
      const value = parseIndianAmount(valueMatch[1]);
      if (value !== null && value > 0) flush(value);
      continue;
    }
  }

  if (holdings.length === 0 && transactions.length === 0) {
    warnings.push(
      'No holdings could be read. CAS layouts differ between CAMS, KFintech and the depositories — if this one is not recognised, the holdings can be entered on the Investments page instead.',
    );
  }

  return { holdings, transactions, warnings };
}

/**
 * The statement's period, when it states one.
 *
 * Used to warn before importing a range that overlaps what is already stored.
 */
export function detectPeriod(lines: string[]): { from: string; to: string } | null {
  for (const raw of lines.slice(0, 60)) {
    const line = squash(raw);
    const m = /(?:from|period|statement period)\s*[:.]?\s*(.{6,22}?)\s*(?:to|-|–)\s*(.{6,22}?)(?:\s|$)/i.exec(line);
    if (!m) continue;
    const from = parseLooseDate(m[1].trim());
    const to = parseLooseDate(m[2].trim());
    if (from && to && from <= to) return { from, to };
  }
  return null;
}

/** A quick count, so the UI can say what it found before the user commits. */
export function summarise(lines: string[]): { dated: number; withAmounts: number } {
  let dated = 0;
  let withAmounts = 0;
  for (const line of lines) {
    if (findAmounts(line).length > 0) withAmounts++;
    if (parseLooseDate(squash(line).slice(0, 12))) dated++;
  }
  return { dated, withAmounts };
}
