/**
 * Reading a spreadsheet statement.
 *
 * Deliberately not SheetJS. The `xlsx` package on npm is pinned at 0.18.5 and
 * carries a known prototype-pollution advisory; the fixed builds live on the
 * vendor's own CDN, which this app's CSP blocks on purpose. An XLSX file is a
 * ZIP of XML and the only thing needed here is cell text, so it is read
 * directly — `fflate` for the ZIP, `DOMParser` for the XML, both already safe
 * and the former about 8 kB.
 *
 * The other half of the problem is that half the "`.xls`" files Indian banks
 * hand out are not spreadsheets at all. HDFC and ICICI both export an HTML
 * table with a `.xls` extension, which Excel opens happily and every real XLSX
 * parser rejects. So the format is sniffed from the bytes rather than trusted
 * from the filename.
 */
import { squash } from './tokens';

export type SheetFormat = 'XLSX' | 'HTML_TABLE' | 'DELIMITED' | 'UNKNOWN';

/**
 * What is this file really?
 *
 * By content, never by extension. A `.xls` from an Indian bank portal is as
 * likely to be HTML as a spreadsheet.
 */
export function sniffFormat(bytes: Uint8Array): SheetFormat {
  // ZIP magic. Every XLSX (and every ODS) starts with it.
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'XLSX';

  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, 2048))
    .toLowerCase();

  if (/<html|<table|<!doctype html/.test(head)) return 'HTML_TABLE';

  // The old binary .xls (BIFF) starts with a compound-document signature.
  // Not supported — and worth saying so rather than producing nonsense.
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf) return 'UNKNOWN';

  if (/[,;\t]/.test(head)) return 'DELIMITED';

  return 'UNKNOWN';
}

/** XML entity decoding, for the handful that appear in cell text. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/** "BC12" -> 54. Spreadsheet columns are base-26 with no zero. */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref.toUpperCase())?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Pull the cell text out of a worksheet, as a grid.
 *
 * Only values are read — no formulas, no styles, no dates-as-serial-numbers
 * conversion. A bank's export writes dates as text, and a cached formula value
 * is written alongside the formula, so the cached value is what gets read.
 */
function parseSheetXml(xml: string, shared: string[]): string[][] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return [];

  const rows: string[][] = [];
  for (const row of Array.from(doc.getElementsByTagName('row'))) {
    const cells: string[] = [];
    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const ref = c.getAttribute('r') ?? '';
      const type = c.getAttribute('t');
      let text = '';

      if (type === 's') {
        // Shared string: the <v> is an index into the shared table.
        const idx = Number(c.getElementsByTagName('v')[0]?.textContent ?? '-1');
        text = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        text = Array.from(c.getElementsByTagName('t'))
          .map((t) => t.textContent ?? '')
          .join('');
      } else {
        text = c.getElementsByTagName('v')[0]?.textContent ?? '';
      }

      // Honour the cell reference so a blank column is not silently closed up —
      // which column an amount sits in is how direction gets decided.
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = text;
    }
    rows.push(cells);
  }
  return rows;
}

/** Rows of cells rendered as fixed-width lines, as the text parsers expect. */
export function gridToLines(grid: string[][]): string[] {
  return grid
    .map((row) => row.map((cell) => squash(String(cell ?? '')).padEnd(18)).join(' ').trimEnd())
    .filter((line) => line.trim().length > 0);
}

/**
 * Read an XLSX into a grid.
 *
 * `fflate` is lazily imported: a spreadsheet statement is a minority case and
 * there is no reason for the unzip code to sit in the import page's chunk for
 * everyone else.
 */
export async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  const { unzipSync, strFromU8 } = await import('fflate');

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('That spreadsheet could not be opened — the file may be damaged.');
  }

  const read = (name: string) => (files[name] ? strFromU8(files[name]) : null);

  // Shared strings: most cell text in an XLSX lives here rather than inline.
  const shared: string[] = [];
  const sharedXml = read('xl/sharedStrings.xml');
  if (sharedXml) {
    const doc = new DOMParser().parseFromString(sharedXml, 'application/xml');
    for (const si of Array.from(doc.getElementsByTagName('si'))) {
      shared.push(
        Array.from(si.getElementsByTagName('t'))
          .map((t) => t.textContent ?? '')
          .join(''),
      );
    }
  }

  // Every worksheet, in file order. A bank export is usually one sheet, but
  // reading them all costs nothing and some split by month.
  const sheetNames = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();

  if (sheetNames.length === 0) {
    throw new Error('That file is a ZIP but does not contain a spreadsheet.');
  }

  const grid: string[][] = [];
  for (const name of sheetNames) {
    const xml = read(name);
    if (xml) grid.push(...parseSheetXml(xml, shared));
  }
  return grid;
}

/**
 * Read the HTML table that several Indian banks export as ".xls".
 *
 * Parsed with DOMParser rather than a regex, and the result is read as text
 * only — no node is ever inserted into the live document, so a hostile file
 * cannot execute anything.
 */
export function readHtmlTable(html: string): string[][] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const grid: string[][] = [];

  for (const tr of Array.from(doc.getElementsByTagName('tr'))) {
    const cells = Array.from(tr.querySelectorAll('td, th')).map((c) =>
      unescapeXml(squash(c.textContent ?? '')),
    );
    if (cells.some((c) => c.length > 0)) grid.push(cells);
  }
  return grid;
}
