/**
 * The single write path into the database.
 *
 * Nothing in the UI touches Dexie tables directly for writes. Everything goes
 * through here so that each mutation also stamps `updatedAt`/`deviceId` and
 * enqueues a sync op — which is what keeps the two devices consistent.
 *
 * Deletes are soft (`deletedAt` is set) so that a deletion on one device
 * actually propagates instead of the record being resurrected by the other
 * device's copy on the next pull.
 */
import type { Table } from 'dexie';
import { db } from './schema';
import type { BaseRecord, SyncTable } from '@/types';

/** Stable per-browser id, used as the last-write-wins tiebreaker. */
const DEVICE_ID_KEY = 'paisatrack.deviceId';

export function getDeviceId(): string {
  if (typeof localStorage === 'undefined') return 'server';
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `dev_${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

function tableFor(name: SyncTable): Table<BaseRecord, string> {
  return db[name] as unknown as Table<BaseRecord, string>;
}

/**
 * Local-change notification.
 *
 * The sync engine registers here rather than the repository importing the
 * engine, which would be a cycle (the engine needs bulkPut and getDeviceId
 * from this module).
 */
type ChangeListener = () => void;
const changeListeners = new Set<ChangeListener>();

export function onLocalChange(fn: ChangeListener): () => void {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
}

function emitChange(): void {
  for (const fn of changeListeners) {
    try {
      fn();
    } catch {
      // A broken listener must never fail the write that triggered it.
    }
  }
}

/** Queue a change for the sync engine to push. */
async function enqueue(table: SyncTable, recordId: string, operation: 'PUT' | 'DELETE'): Promise<void> {
  await db._syncQueue.add({ table, recordId, operation, queuedAt: nowISO() });
  emitChange();
}

export interface WriteOptions {
  /** Skip the sync queue. Used when applying records that came *from* sync. */
  skipSync?: boolean;
}

/** Insert a new record, generating id and timestamps. */
export async function create<T extends BaseRecord>(
  table: SyncTable,
  idPrefix: string,
  data: Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>,
  opts: WriteOptions = {},
): Promise<T> {
  const now = nowISO();
  const record = {
    ...data,
    id: newId(idPrefix),
    createdAt: now,
    updatedAt: now,
    deviceId: getDeviceId(),
    deletedAt: null,
  } as unknown as T;

  await tableFor(table).add(record);
  if (!opts.skipSync) await enqueue(table, record.id, 'PUT');
  return record;
}

/** Patch an existing record. Bumps updatedAt so sync resolves in its favour. */
export async function update<T extends BaseRecord>(
  table: SyncTable,
  id: string,
  patch: Partial<Omit<T, 'id' | 'createdAt'>>,
  opts: WriteOptions = {},
): Promise<void> {
  await tableFor(table).update(id, {
    ...patch,
    updatedAt: nowISO(),
    deviceId: getDeviceId(),
  } as Partial<BaseRecord>);
  if (!opts.skipSync) await enqueue(table, id, 'PUT');
}

/** Insert or replace wholesale. Used by import and by the sync engine. */
export async function put<T extends BaseRecord>(
  table: SyncTable,
  record: T,
  opts: WriteOptions = {},
): Promise<void> {
  await tableFor(table).put(record);
  if (!opts.skipSync) await enqueue(table, record.id, 'PUT');
}

/**
 * Soft delete. The row stays in IndexedDB with `deletedAt` set so the tombstone
 * can travel to the other device; `list()` filters these out.
 */
export async function remove(
  table: SyncTable,
  id: string,
  opts: WriteOptions = {},
): Promise<void> {
  await tableFor(table).update(id, {
    deletedAt: nowISO(),
    updatedAt: nowISO(),
    deviceId: getDeviceId(),
  } as Partial<BaseRecord>);
  if (!opts.skipSync) await enqueue(table, id, 'DELETE');
}

/** Permanently drop a record. Only used when purging old tombstones. */
export async function hardDelete(table: SyncTable, id: string): Promise<void> {
  await tableFor(table).delete(id);
}

/** All live (non-deleted) records in a table. */
export async function list<T extends BaseRecord>(table: SyncTable): Promise<T[]> {
  const rows = (await tableFor(table).toArray()) as unknown as T[];
  return rows.filter((r) => !r.deletedAt);
}

export async function get<T extends BaseRecord>(table: SyncTable, id: string): Promise<T | undefined> {
  const row = (await tableFor(table).get(id)) as unknown as T | undefined;
  return row && !row.deletedAt ? row : undefined;
}

/** Bulk insert without queueing — used by the seeder and the sync applier. */
export async function bulkPut<T extends BaseRecord>(
  table: SyncTable,
  records: T[],
  opts: WriteOptions = {},
): Promise<void> {
  if (records.length === 0) return;
  await tableFor(table).bulkPut(records as unknown as BaseRecord[]);
  if (!opts.skipSync) {
    await db._syncQueue.bulkAdd(
      records.map((r) => ({
        table,
        recordId: r.id,
        operation: 'PUT' as const,
        queuedAt: nowISO(),
      })),
    );
    emitChange();
  }
}

/**
 * Drop tombstones that both devices have certainly seen, so the data.json
 * committed to GitHub does not grow without bound.
 */
export async function purgeOldTombstones(olderThanDays = 90): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
  let purged = 0;
  for (const name of Object.keys(db).filter((k) => !k.startsWith('_')) as SyncTable[]) {
    const t = tableFor(name);
    if (!t) continue;
    const rows = (await t.toArray()) as BaseRecord[];
    const stale = rows.filter((r) => r.deletedAt && r.deletedAt < cutoff);
    if (stale.length) {
      await t.bulkDelete(stale.map((r) => r.id));
      purged += stale.length;
    }
  }
  return purged;
}
