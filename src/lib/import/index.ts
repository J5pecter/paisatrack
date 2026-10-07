/**
 * Statement import, end to end.
 *
 * File in, reviewable candidates out. The one rule this module exists to
 * enforce: **nothing reaches the database without the user seeing it first.**
 * A misread row in someone's finances is worse than no row, and a parser
 * working across a dozen bank layouts will misread some of them.
 *
 * Everything runs in the browser. There is no server to upload a statement to,
 * and every hosted OCR service wants a card — which the product forbids. For a
 * document containing someone's salary and account numbers, staying local is
 * the right answer regardless.
 */
import Papa from 'papaparse';
import { checkImportFile, MAX_IMPORT_BYTES } from '@/lib/validation';
import { detectPeriod, detectStatement, parseCas, type ParsedHolding } from './detect';
import { extractTransactions, type ParsedTxn, type StatementKind } from './statement';
import { extractPdfText } from './pdf';

export { PasswordRequired, PdfUnreadable } from './pdf';
export type { ParsedTxn } from './statement';
export type { ParsedHolding } from './detect';

export interface ImportResult {
  kind: StatementKind;
  source: string;
  period: { from: string; to: string } | null;
  transactions: ParsedTxn[];
  holdings: ParsedHolding[];
  warnings: string[];
  /** For the "we read N pages / N rows" line, so a bad parse is obvious. */
  stats: { pages?: number; lines: number };
}

/** Read a picked file into memory, with the same size guard as every other import. */
async function readFile(file: File): Promise<ArrayBuffer> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB — larger than any real statement.`,
    );
  }
  return file.arrayBuffer();
}

/**
 * A CSV statement.
 *
 * Several banks and all three UPI apps offer CSV, and it is always better than
 * the PDF: the columns are already separated, so nothing has to be inferred
 * from layout. The rows are flattened back to text lines and handed to the same
 * extractor, which keeps one set of rules for direction and categories rather
 * than two that can disagree.
 */
function linesFromCsv(text: string): string[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  return (parsed.data as string[][])
    .filter((row) => Array.isArray(row))
    // Padded so columns stay at stable offsets — the extractor reads debit
    // versus credit from horizontal position, which a plain join would destroy.
    .map((row) => row.map((cell) => String(cell ?? '').trim().padEnd(18)).join(' '));
}

/**
 * Parse a statement into candidates.
 *
 * Throws `PasswordRequired` when a PDF is encrypted, which most Indian bank and
 * card statements are. The caller collects the password and calls again.
 */
export async function parseStatement(file: File, password?: string): Promise<ImportResult> {
  const isPdf = /\.pdf$/i.test(file.name);

  if (!isPdf) {
    const check = checkImportFile(file, 'csv');
    if (!check.ok) throw new Error(check.message ?? 'That file cannot be read.');
  }

  const buffer = await readFile(file);

  let lines: string[];
  let pages: number | undefined;

  if (isPdf) {
    const text = await extractPdfText(buffer, password);
    lines = text.lines;
    pages = text.pages;
  } else {
    lines = linesFromCsv(new TextDecoder().decode(buffer));
  }

  const { kind, source } = detectStatement(lines);
  const period = detectPeriod(lines);

  // A CAS is a list of what you hold, not of what you spent. Running the
  // transaction extractor over one would turn every valuation row into a
  // purchase, which is why the two paths are kept apart.
  if (kind === 'CAS') {
    const cas = parseCas(lines);
    return {
      kind,
      source,
      period,
      transactions: [],
      holdings: cas.holdings,
      warnings: cas.warnings,
      stats: { pages, lines: lines.length },
    };
  }

  const extracted = extractTransactions(lines, kind);
  const warnings = [...extracted.warnings];

  if (extracted.transactions.length === 0) {
    warnings.push(
      'No transactions were recognised. If this is a scanned statement there is no text to read; download the original from your bank or card portal instead.',
    );
  }

  return {
    kind,
    source,
    period,
    transactions: extracted.transactions,
    holdings: [],
    warnings,
    stats: { pages, lines: lines.length },
  };
}
