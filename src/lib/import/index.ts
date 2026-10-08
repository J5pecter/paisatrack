/**
 * Statement import, end to end.
 *
 * File in, reviewable candidates out. The one rule this module exists to
 * enforce: **nothing reaches the database without the user seeing it first.**
 * A misread row in someone's finances is worse than no row, and a parser
 * working across a dozen bank layouts will misread some of them.
 *
 * Everything here runs in the browser by default, and every path in this file
 * except one completes without a network connection at all.
 *
 * The exception is `parseViaServer`, and it is reached only by pressing a
 * button that says what it does. A scan that the on-device engine cannot read
 * is the one case where the alternative is typing forty rows by hand, so the
 * escape hatch exists — but it uploads the statement, and nothing else in
 * PaisaTrack does. It is never the default, never automatic, and never
 * silent.
 */
import Papa from 'papaparse';
import { checkImportFile, MAX_IMPORT_BYTES } from '@/lib/validation';
import { detectPeriod, detectStatement, parseCas, type CasTxn, type ParsedHolding } from './detect';
import {
  extractTransactions,
  fingerprint as casFingerprint,
  type ParsedTxn,
  type StatementKind,
} from './statement';
import { extractPdfText } from './pdf';

/** "PURCHASE" -> "Purchase". The kinds are already readable, just shouty. */
function humaniseKind(kind: CasTxn['kind']): string {
  return kind.charAt(0) + kind.slice(1).toLowerCase();
}

export { PasswordRequired, PdfUnreadable } from './pdf';
export type { ParsedTxn } from './statement';
export type { CasTxn, ParsedHolding } from './detect';
export type { OcrProgress } from './ocr';

export interface ImportResult {
  kind: StatementKind;
  source: string;
  period: { from: string; to: string } | null;
  transactions: ParsedTxn[];
  holdings: ParsedHolding[];
  /** Dated movements from a CAS: SIPs, purchases, redemptions. */
  casTransactions: CasTxn[];
  warnings: string[];
  /** For the "we read N pages / N lines" line, so a bad parse is obvious. */
  stats: { pages?: number; lines: number };
  /** True when the rows came from OCR and are therefore all suspect. */
  viaOcr: boolean;
  /**
   * Which engine read it, when `viaOcr`.
   *
   * Worth distinguishing in the UI rather than collapsing into "OCR": one of
   * these ran on the device and one uploaded the statement to a server. The
   * user chose the second deliberately and should be told it happened.
   */
  ocrSource?: 'LOCAL' | 'SERVER';
}

/**
 * Raised when a PDF has no text layer.
 *
 * Carries the bytes so the caller can offer OCR without asking for the file
 * again, and so running OCR stays an explicit choice rather than something
 * that happens silently behind a long spinner.
 */
export class NeedsOcr extends Error {
  constructor(
    readonly data: ArrayBuffer,
    readonly password: string | undefined,
    readonly pages: number,
  ) {
    super('This PDF has no text layer.');
    this.name = 'NeedsOcr';
  }
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
 * from layout. The rows are flattened back to padded text lines and handed to
 * the same extractor, which keeps one set of rules for direction and category
 * rather than two that can disagree.
 */
function linesFromCsv(text: string): string[] {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  return (parsed.data as string[][])
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? '').trim().padEnd(18)).join(' '));
}

/**
 * Turn extracted lines into a reviewable result.
 *
 * Shared by the text and OCR paths so both go through exactly the same
 * detection, extraction and category rules — the only difference being that
 * OCR output is never trusted.
 */
function buildResult(
  lines: string[],
  pages: number | undefined,
  viaOcr: boolean,
  ocrSource?: 'LOCAL' | 'SERVER',
): ImportResult {
  const { kind, source } = detectStatement(lines);
  const period = detectPeriod(lines);

  // A CAS describes what you hold and how you got there. Running the
  // transaction extractor over one would read every valuation row as a
  // purchase, so the two are parsed separately.
  if (kind === 'CAS') {
    const cas = parseCas(lines);

    /*
      The dated movements become ordinary transactions so they can go through
      the same review screen as everything else. An SIP instalment is money
      leaving a bank account for a fund — it is an outflow, categorised as
      INVESTMENT. A redemption is the same money coming back.

      Switches are excluded: a switch moves value between two schemes without
      anything leaving the bank, so importing one as an expense would invent
      spending that never happened.
    */
    const asTransactions: ParsedTxn[] = cas.transactions
      .filter((t) => t.kind !== 'SWITCH')
      .map((t) => {
        const direction = t.kind === 'REDEMPTION' || t.kind === 'DIVIDEND' ? 'CREDIT' : 'DEBIT';
        const description = `${t.kind === 'SIP' ? 'SIP' : humaniseKind(t.kind)} · ${t.scheme}`;
        return {
          date: t.date,
          description,
          amount: t.amount,
          direction,
          category: 'INVESTMENT' as const,
          // The registrar prints these in a fixed column order, so they are
          // read positionally rather than inferred.
          confidence: viaOcr ? ('LOW' as const) : ('HIGH' as const),
          fingerprint: casFingerprint(t.date, t.amount, description),
        };
      });

    return {
      kind,
      source,
      period,
      transactions: asTransactions,
      holdings: cas.holdings,
      casTransactions: cas.transactions,
      warnings: cas.warnings,
      stats: { pages, lines: lines.length },
      viaOcr,
      ocrSource,
    };
  }

  const extracted = extractTransactions(lines, kind);
  const warnings = [...extracted.warnings];

  // OCR output is demoted wholesale. Tesseract reads dense numeric tables
  // poorly — 8 against B, 0 against O — and a confident-looking rupee figure
  // off a scan has not earned that confidence, whatever the parser concluded
  // from the column or the balance.
  const transactions = viaOcr
    ? extracted.transactions.map((t) => ({ ...t, confidence: 'LOW' as const }))
    : extracted.transactions;

  if (transactions.length === 0) {
    warnings.push(
      viaOcr
        ? 'Nothing recognisable was read from the scan. OCR struggles with small print and skewed pages — a statement downloaded from the portal will always work better.'
        : 'No transactions were recognised.',
    );
  }

  return {
    kind,
    source,
    period,
    transactions,
    holdings: [],
    casTransactions: [],
    warnings,
    stats: { pages, lines: lines.length },
    viaOcr,
    ocrSource,
  };
}

/**
 * Parse a statement into candidates.
 *
 * Throws `PasswordRequired` when a PDF is encrypted, which most Indian bank and
 * card statements are, and `NeedsOcr` when a PDF turns out to be a scan.
 */
export async function parseStatement(file: File, password?: string): Promise<ImportResult> {
  const isPdf = /\.pdf$/i.test(file.name);
  const isImage = /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
  const buffer = await readFile(file);

  // A photograph has no text layer by definition; there is nothing to try first.
  if (isImage) {
    throw new NeedsOcr(buffer, undefined, 1);
  }

  if (isPdf) {
    try {
      const text = await extractPdfText(buffer, password);
      return buildResult(text.lines, text.pages, false);
    } catch (e) {
      // "No text layer" is not a failure, it is a different route.
      if (e instanceof Error && e.name === 'PdfUnreadable' && /no text layer/i.test(e.message)) {
        const { pdfPageCount } = await import('./ocr');
        const pages = await pdfPageCount(buffer, password).catch(() => 1);
        throw new NeedsOcr(buffer, password, pages);
      }
      throw e;
    }
  }

  /*
    Everything else is identified by its bytes, not its name. Half the ".xls"
    files Indian bank portals produce are HTML tables rather than spreadsheets
    — Excel opens them, every real XLSX parser rejects them, and trusting the
    extension would mean telling the user a perfectly good statement is corrupt.
  */
  const bytes = new Uint8Array(buffer);
  const { sniffFormat, readXlsx, readHtmlTable, gridToLines } = await import('./spreadsheet');

  switch (sniffFormat(bytes)) {
    case 'XLSX':
      return buildResult(gridToLines(await readXlsx(bytes)), undefined, false);
    case 'HTML_TABLE':
      return buildResult(gridToLines(readHtmlTable(new TextDecoder().decode(bytes))), undefined, false);
    case 'DELIMITED': {
      const check = checkImportFile(file, 'csv');
      if (!check.ok) throw new Error(check.message ?? 'That file cannot be read.');
      return buildResult(linesFromCsv(new TextDecoder().decode(bytes)), undefined, false);
    }
    default:
      throw new Error(
        'That file is not a format PaisaTrack can read. The old binary .xls is not supported — re-export as CSV or XLSX, which every bank portal offers.',
      );
  }
}

/**
 * Read a scan with OCR, after the user has asked for it.
 *
 * Separate from `parseStatement` on purpose: this downloads a language model,
 * spins up a worker and can take a minute, none of which should happen because
 * someone picked the wrong file.
 */
export async function parseViaOcr(
  needsOcr: NeedsOcr,
  isImage: boolean,
  onProgress?: (p: import('./ocr').OcrProgress) => void,
): Promise<ImportResult> {
  const { ocrImages, renderPdfToImages } = await import('./ocr');

  let images: Blob[];
  let pages: number;
  let truncated = false;

  if (isImage) {
    images = [new Blob([needsOcr.data])];
    pages = 1;
  } else {
    const rendered = await renderPdfToImages(needsOcr.data, needsOcr.password, onProgress);
    images = rendered.images;
    pages = rendered.totalPages;
    truncated = rendered.truncated;
  }

  const lines = await ocrImages(images, onProgress);
  const result = buildResult(lines, pages, true, 'LOCAL');

  if (truncated) {
    result.warnings.unshift(
      `Only the first ${images.length} of ${pages} pages were read. OCR is slow enough that doing the whole document would hang the tab; import these, then split the file to do the rest.`,
    );
  }

  return result;
}

/**
 * Read a scan with the Cloudflare Worker, after the user has asked for it.
 *
 * Separate from `parseViaOcr` for the reason that matters: **this uploads the
 * statement.** Tesseract is slow and sometimes wrong, but the document never
 * leaves the device; this is faster and usually better and sends a page
 * containing someone's salary and account number to a third party. That is a
 * trade only the user can make, so it lives behind its own explicit action and
 * its own warning.
 *
 * The Worker returns a transcription, not an interpretation. It goes through
 * the same `buildResult` as every other path, which means the running-balance
 * check runs over it unchanged — and that check is what catches a model
 * inventing a figure, because an invented amount does not reconcile with the
 * balance printed next to it.
 */
export async function parseViaServer(
  needsOcr: NeedsOcr,
  isImage: boolean,
  call: import('@/lib/server/config').WorkerCall,
  onProgress?: (p: import('./ocr').OcrProgress) => void,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const { readViaServer } = await import('./serverOcr');

  let images: Blob[];
  let pages: number;
  let truncated = false;

  if (isImage) {
    images = [new Blob([needsOcr.data])];
    pages = 1;
  } else {
    // Rendering is the same work either way — a vision model needs a bitmap
    // just as Tesseract does. The page cap applies here too, and matters more:
    // each page spends part of a daily neuron allowance.
    const { renderPdfToImages } = await import('./ocr');
    const rendered = await renderPdfToImages(needsOcr.data, needsOcr.password, (p) =>
      onProgress?.({ ratio: p.ratio * 0.3, message: p.message }),
    );
    images = rendered.images;
    pages = rendered.totalPages;
    truncated = rendered.truncated;
  }

  const response = await readViaServer(call, images, onProgress, signal);
  const result = buildResult(response.lines, pages, true, 'SERVER');

  if (truncated) {
    result.warnings.unshift(
      `Only the first ${images.length} of ${pages} pages were read. Import these, then split the file to do the rest.`,
    );
  }

  // A page the model refused or failed on is a silent hole in the middle of a
  // statement otherwise, which is exactly the kind of gap someone reconciles
  // against their bank and cannot explain.
  for (const failure of response.failures ?? []) {
    result.warnings.unshift(`${failure} — that page contributed no rows.`);
  }

  return result;
}
