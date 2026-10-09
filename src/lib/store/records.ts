/**
 * The record store.
 *
 * PaisaTrack used to be local-first: records lived in IndexedDB and an optional
 * GitHub sync reconciled devices with last-write-wins, tombstones and a deviceId
 * tiebreaker. They live on a Cloudflare Worker now, and this module is what the
 * app reads from instead.
 *
 * ## Why this is so much smaller than the sync engine it replaced
 *
 * Because there is one writer. Nearly all of that machinery existed to settle
 * disagreements between two devices that had both edited while offline — which
 * is a genuinely hard problem, and not one this app has. With a single
 * authoritative copy and a single person writing to it, a write is a write and
 * a delete is a delete.
 *
 * ## In memory, not on disk
 *
 * Nothing here is persisted. The data is fetched once on load, held in memory
 * for the session, and written straight through to the server. Close the tab
 * and the copy is gone; open it again and it is fetched fresh.
 *
 * The cost is real and worth stating plainly: **the app does not work offline
 * any more.** With no connection there is nothing to show, because the only
 * copy is on the server. That was a deliberate trade for a single mental model
 * — one dataset, always current, reachable from any device — over a cache that
 * can disagree with the thing it is caching.
 *
 * ## Writes are confirmed, not optimistic
 *
 * A mutation updates this store only *after* the server has accepted it. That
 * costs a round trip on every change, and it buys the property that matters
 * more: what you see is what is stored. An optimistic UI that rolls back on
 * failure is nicer until the rollback is a salary figure you already stopped
 * looking at.
 */
import { SYNC_TABLES, type BaseRecord, type SyncTable } from '@/types';
import { postToWorker, workerCall, type WorkerCall } from '@/lib/server/config';

/** Returned for a table that has no rows. One frozen instance, so the reference is stable. */
const EMPTY: readonly BaseRecord[] = Object.freeze([]);

const tables = new Map<SyncTable, readonly BaseRecord[]>();
const listeners = new Set<() => void>();

export type Status = 'IDLE' | 'LOADING' | 'READY' | 'ERROR';

let status: Status = 'IDLE';
let error: string | null = null;

/** Bumped on every change, so a hook can depend on "something happened" cheaply. */
let version = 0;

function notify(): void {
  version++;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The rows of one table.
 *
 * Returns the *same array reference* until that table changes, which is what
 * `useSyncExternalStore` requires — a getter that built a new array each call
 * would re-render every subscriber on every render, forever.
 */
export function getTable<T extends BaseRecord>(table: SyncTable): readonly T[] {
  return (tables.get(table) ?? EMPTY) as readonly T[];
}

export function getStatus(): Status {
  return status;
}

export function getError(): string | null {
  return error;
}

export function getVersion(): number {
  return version;
}

function setTable(table: SyncTable, rows: readonly BaseRecord[]): void {
  tables.set(table, Object.freeze(rows));
}

/** Raised when there is no Worker configured, which is a setup state rather than a failure. */
export class NotConfigured extends Error {
  constructor() {
    super('No server is configured.');
    this.name = 'NotConfigured';
  }
}

/**
 * Fetch everything.
 *
 * One request for the whole dataset, because it is small and because seventeen
 * per-table requests to render a dashboard would be seventeen chances to show a
 * half-loaded balance sheet. The old local version had the same rule for the
 * same reason — every figure on screen comes from one consistent snapshot.
 */
export async function loadAll(): Promise<void> {
  const call = await workerCall();
  if (!call) {
    status = 'IDLE';
    throw new NotConfigured();
  }

  status = 'LOADING';
  error = null;
  notify();

  try {
    const response = await fetch(`${call.url}/data`, {
      headers: { Authorization: `Bearer ${call.token}` },
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'The server rejected the token. Check it matches the Worker’s API_TOKEN.'
          : `The server returned ${response.status}.`,
      );
    }

    const document = (await response.json()) as Record<string, BaseRecord[]>;

    // Every table is set, including the absent ones — otherwise a table that
    // used to have rows and no longer does would keep showing the old ones.
    for (const table of SYNC_TABLES) {
      setTable(table, document[table] ?? []);
    }

    status = 'READY';
  } catch (e) {
    status = 'ERROR';
    error =
      e instanceof Error
        ? e.message
        : 'Could not reach the server. PaisaTrack needs it to show anything.';
    throw e;
  } finally {
    notify();
  }
}

export interface WriteOp {
  tbl: SyncTable;
  id: string;
  /** JSON text of the record. Absent means delete. */
  data?: string;
}

/**
 * The server's batch limit.
 *
 * Mirrors `MAX_OPS` in the Worker, which exists because parsing the request
 * body is the one cost there that scales with payload size and the free plan
 * allows 10ms of CPU. Chunking here means a 900-record migration is four
 * requests rather than one rejection.
 */
const MAX_OPS = 200;

/**
 * Send writes, then apply them locally.
 *
 * Order matters. Applying first and reverting on failure would mean a figure
 * briefly appearing in the UI that is not in the database — which for money is
 * worse than a short wait.
 */
export async function write(call: WorkerCall, ops: WriteOp[]): Promise<void> {
  if (ops.length === 0) return;

  for (let i = 0; i < ops.length; i += MAX_OPS) {
    await postToWorker(call, '/data/write', { ops: ops.slice(i, i + MAX_OPS) });
  }
}

/**
 * Apply accepted writes to the in-memory copy.
 *
 * Called only after the server has confirmed them. Each affected table gets a
 * new array so `useSyncExternalStore` sees the change; untouched tables keep
 * their existing reference and their subscribers do not re-render.
 */
export function applyLocally(records: { table: SyncTable; record?: BaseRecord; id: string }[]): void {
  const touched = new Set<SyncTable>();
  const next = new Map<SyncTable, BaseRecord[]>();

  for (const { table } of records) {
    if (!touched.has(table)) {
      touched.add(table);
      next.set(table, [...getTable(table)]);
    }
  }

  for (const { table, record, id } of records) {
    const rows = next.get(table)!;
    const index = rows.findIndex((r) => r.id === id);

    if (!record) {
      if (index >= 0) rows.splice(index, 1);
      continue;
    }
    if (index >= 0) rows[index] = record;
    else rows.push(record);
  }

  for (const [table, rows] of next) setTable(table, rows);
  if (touched.size > 0) notify();
}

/** Drop everything held in memory. Used on sign-out and after a wipe. */
export function clear(): void {
  tables.clear();
  status = 'IDLE';
  error = null;
  notify();
}

/** Every record currently held, as write ops. Used by the export and the wipe-and-restore path. */
export function allAsOps(): WriteOp[] {
  const ops: WriteOp[] = [];
  for (const table of SYNC_TABLES) {
    for (const record of getTable(table)) {
      ops.push({ tbl: table, id: record.id, data: JSON.stringify(record) });
    }
  }
  return ops;
}
