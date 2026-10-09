/**
 * The database.
 *
 * PaisaTrack's records live in D1 — one table, one row per record, the record
 * itself held as the JSON text the client sent. That is a deliberate choice
 * over a column per field, and it is mostly about the 10ms CPU budget.
 *
 * ## Why the data is opaque text
 *
 * A normalised schema would mean this Worker parsing every incoming record and
 * re-serialising every outgoing one. At a few hundred rows that is real CPU —
 * the one resource the free plan does not give us — spent re-deriving something
 * the client already had in exactly the right shape.
 *
 * Storing the JSON verbatim means a read can be assembled by **string
 * concatenation**: the rows come back from D1 with their `data` column already
 * being valid JSON text, so the response is built by joining them with commas.
 * Nothing is parsed. Nothing is stringified. The cost of returning a thousand
 * records is the cost of joining a thousand strings.
 *
 * The trade is that the server cannot validate or query inside a record. That
 * is acceptable here and nowhere near as alarming as it sounds: there is one
 * writer, it validates with Zod before sending, and every figure the app
 * reports is computed on the device from these records. This is storage, not a
 * domain model. If PaisaTrack ever grows a second user or a server-side report,
 * this is the decision to revisit first.
 *
 * ## Why there are no tombstones
 *
 * The old GitHub sync soft-deleted everything, because two devices editing
 * offline need a deletion to beat a stale edit. With a single writer and a
 * single authoritative copy there is no stale edit to beat: a delete is a
 * delete. `DELETE FROM records` and the row is gone.
 */

/** Only these table names are accepted. Anything else is a bug or an attack. */
const TABLES = new Set([
  'users',
  'income',
  'salaryProfile',
  'creditCards',
  'statements',
  'cardTxns',
  'cardPayments',
  'loans',
  'loanPayments',
  'bills',
  'billEntries',
  'expenses',
  'investments',
  'budgets',
  'goals',
  'reminders',
  'cashAccounts',
]);

/**
 * Ops per request.
 *
 * The one place this Worker genuinely must parse JSON is an incoming write, and
 * the cost scales with the payload. 200 records of a few hundred bytes is a
 * millisecond or two; an unbounded migration batch is how you discover the CPU
 * limit in production. The client chunks.
 */
export const MAX_OPS = 200;

export interface WriteOp {
  tbl: string;
  id: string;
  /** The record as JSON text. Absent means delete. */
  data?: string;
}

/**
 * The schema, applied on demand.
 *
 * `IF NOT EXISTS` on every statement so this is safe to run before any request
 * rather than requiring a separate migration step during setup — one fewer
 * thing to get wrong in the README, and D1 makes it cheap.
 */
export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS records (
         id         TEXT PRIMARY KEY,
         tbl        TEXT NOT NULL,
         updated_at TEXT NOT NULL,
         data       TEXT NOT NULL
       )`,
    ),
    // Reads are always "everything, grouped by table", so this is the index
    // that matters and the only one worth the write cost.
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_tbl ON records(tbl)`),
  ]);
}

/**
 * Everything, as a JSON document grouped by table.
 *
 * Assembled by concatenation — see the note at the top of this file. The result
 * is a string rather than an object precisely so that no part of it is ever
 * handed to `JSON.stringify`.
 */
export async function readAll(db: D1Database): Promise<string> {
  const { results } = await db
    .prepare(`SELECT tbl, data FROM records ORDER BY tbl`)
    .all<{ tbl: string; data: string }>();

  let out = '{';
  let current: string | null = null;
  let first = true;

  for (const row of results) {
    if (row.tbl !== current) {
      if (current !== null) out += ']';
      out += `${current === null ? '' : ','}${JSON.stringify(row.tbl)}:[`;
      current = row.tbl;
      first = true;
    }
    if (!first) out += ',';
    // Verbatim. The client wrote this JSON; it comes back exactly as sent.
    out += row.data;
    first = false;
  }

  if (current !== null) out += ']';
  return `${out}}`;
}

export interface WriteResult {
  written: number;
  deleted: number;
}

/**
 * Apply a batch of writes atomically.
 *
 * `db.batch()` runs inside one implicit transaction, so a half-applied import
 * is not a state the user can end up in — either the whole batch lands or none
 * of it does.
 */
export async function applyWrites(db: D1Database, ops: WriteOp[]): Promise<WriteResult> {
  const statements: D1PreparedStatement[] = [];
  let written = 0;
  let deleted = 0;
  const now = new Date().toISOString();

  for (const op of ops) {
    if (!TABLES.has(op.tbl)) throw new Error(`Unknown table: ${op.tbl}`);
    if (typeof op.id !== 'string' || op.id.length === 0 || op.id.length > 200) {
      throw new Error('Each op needs an id.');
    }

    if (op.data === undefined) {
      statements.push(db.prepare(`DELETE FROM records WHERE id = ?`).bind(op.id));
      deleted++;
      continue;
    }

    if (typeof op.data !== 'string') throw new Error('`data` must be JSON text.');

    statements.push(
      db
        .prepare(
          `INSERT INTO records (id, tbl, updated_at, data) VALUES (?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET tbl = excluded.tbl,
                                           updated_at = excluded.updated_at,
                                           data = excluded.data`,
        )
        .bind(op.id, op.tbl, now, op.data),
    );
    written++;
  }

  if (statements.length > 0) await db.batch(statements);
  return { written, deleted };
}

/** How many records exist, per table. Cheap, and the only thing Settings needs to show. */
export async function counts(db: D1Database): Promise<Record<string, number>> {
  const { results } = await db
    .prepare(`SELECT tbl, COUNT(*) AS n FROM records GROUP BY tbl`)
    .all<{ tbl: string; n: number }>();

  const out: Record<string, number> = {};
  for (const row of results) out[row.tbl] = row.n;
  return out;
}

/** Delete everything. The danger-zone reset, and it is exactly as final as it looks. */
export async function wipe(db: D1Database): Promise<number> {
  const { results } = await db.prepare(`SELECT COUNT(*) AS n FROM records`).all<{ n: number }>();
  await db.prepare(`DELETE FROM records`).run();
  return results[0]?.n ?? 0;
}
