/**
 * Reading the text out of a statement PDF.
 *
 * The important thing to understand: Indian bank, card and CAS statements are
 * **digitally generated with a real text layer**. This is extraction, not OCR —
 * the characters are already in the file, exact, with their coordinates. OCR is
 * only needed for a photograph or a scan, and it is both far heavier and far
 * less accurate. Reaching for it first would be slower and worse.
 *
 * pdf.js is loaded lazily and only when someone actually picks a PDF. It is
 * ~150 kB plus a ~380 kB worker gzipped, which would be absurd on the critical
 * path of a dashboard and is unremarkable on an import screen.
 *
 * The non-obvious part is `toLines`. A naive extraction concatenates text items
 * with spaces and throws away where they sat — but a bank statement encodes
 * debit versus credit in *which column* the amount is printed in, and that is
 * the single most reliable direction signal there is. So the page is rebuilt as
 * fixed-width text with the horizontal positions preserved.
 */

/** The statement is encrypted and needs the password the issuer set. */
export class PasswordRequired extends Error {
  constructor(readonly wrongPassword: boolean) {
    super(
      wrongPassword
        ? 'That password did not open the file.'
        : 'This PDF is password protected.',
    );
    this.name = 'PasswordRequired';
  }
}

export class PdfUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfUnreadable';
  }
}

interface TextItem {
  str: string;
  transform: number[];
  width: number;
}

/**
 * Rebuild a page as fixed-width lines.
 *
 * Items are grouped into rows by their baseline, then placed at a character
 * column derived from their x coordinate. The unit is the page's median
 * character width, which tracks the document's own font size rather than
 * assuming one.
 */
function toLines(items: TextItem[]): string[] {
  const usable = items.filter((i) => i.str.length > 0 && i.str.trim() !== '');
  if (usable.length === 0) return [];

  // Median character width across the page. Median rather than mean because a
  // single wide heading would otherwise stretch every column on the page.
  const widths = usable
    .filter((i) => i.str.trim().length > 0 && i.width > 0)
    .map((i) => i.width / i.str.length)
    .sort((a, b) => a - b);
  const unit = widths[Math.floor(widths.length / 2)] || 5;

  // Group by baseline. The tolerance absorbs the sub-pixel drift between items
  // that are visually on the same line but not identically positioned.
  const rows = new Map<number, TextItem[]>();
  for (const item of usable) {
    const y = Math.round(item.transform[5] / 3) * 3;
    const row = rows.get(y);
    if (row) row.push(item);
    else rows.set(y, [item]);
  }

  // PDF y grows upward, so descending y is top-to-bottom reading order.
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, row]) => {
      row.sort((a, b) => a.transform[4] - b.transform[4]);
      let line = '';
      for (const item of row) {
        const column = Math.max(0, Math.round(item.transform[4] / unit));
        // At least one space between items, so adjacent cells never fuse into
        // a single unreadable token.
        if (column > line.length) line = line.padEnd(column, ' ');
        else if (line.length > 0) line += ' ';
        line += item.str;
      }
      return line.trimEnd();
    })
    .filter((l) => l.trim().length > 0);
}

export interface PdfText {
  lines: string[];
  pages: number;
}

/**
 * Extract the text of a PDF, preserving column layout.
 *
 * Throws `PasswordRequired` when the file is encrypted — which most Indian
 * statements are, usually with a date of birth or PAN as the password.
 */
export async function extractPdfText(data: ArrayBuffer, password?: string): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist');

  // The worker is a separate chunk; Vite rewrites this URL at build time. The
  // CSP already allows worker-src 'self', so it loads from our own origin.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  /*
    Kept in scope so the worker can be torn down afterwards: in pdf.js 6
    `destroy()` lives on the loading task, not on the document.

    The data is a COPY, deliberately. pdf.js transfers the buffer it is given to its
    worker, which detaches the original — so a second pass over the same file
    (checking the page count, then rendering it for OCR) would throw "Cannot
    perform Construct on a detached ArrayBuffer". Slicing costs one allocation
    and makes the caller's buffer reusable.
  */
  const task = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password: password || undefined,
    // Nothing is fetched from the network: no remote fonts, no external
    // resources. A statement should never cause an outbound request.
    disableFontFace: true,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    const err = e as { name?: string; code?: number; message?: string };
    // pdf.js reports 1 for "needs a password" and 2 for "that was the wrong one".
    if (err.name === 'PasswordException') {
      throw new PasswordRequired(err.code === 2);
    }
    throw new PdfUnreadable(
      'That file could not be opened as a PDF. If it came from a bank portal, try downloading it again.',
    );
  }

  const lines: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    lines.push(...toLines(content.items as unknown as TextItem[]));
    // Pages hold bitmap and font data; without this a long statement keeps all
    // of it alive at once.
    page.cleanup();
  }

  const pages = doc.numPages;
  // Tears down the worker too; without it each import leaks one.
  await task.destroy();

  if (lines.length === 0) {
    throw new PdfUnreadable(
      'This PDF has no text layer — it is a scan or a photograph.',
    );
  }

  return { lines, pages };
}
