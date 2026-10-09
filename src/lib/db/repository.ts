/**
 * THE ONLY WRITE PATH.
 *
 * Every mutation in PaisaTrack goes through this file. That rule predates the
 * move to a server and is the reason the move was tractable at all: there was
 * exactly one place where records changed, so there was exactly one place to
 * repoint.
 *
 * What changed underneath: a write used to land in IndexedDB and get queued for
 * an eventual GitHub sync. It now goes to the Worker and is applied in memory
 * only once the server has accepted it. The function signatures are unchanged,
 * so no page or hook needed editing.
 *
 * ## Confirmed, not optimistic
 *
 * Each of these awaits the server. That is a round trip per change — a couple
 * of hundred milliseconds — and it buys the property that what is on screen is
 * what is stored. The alternative, showing the change immediately and undoing
 * it if the server objects, means a rupee figure can appear, be read, and then
 * quietly revert. For money that is the worse trade.
 *
 * ## No tombstones
 *
 * `remove()` used to write a `deletedAt` so a deletion could propagate through
 * sync and beat a stale edit from another device. With one writer and one
 * authoritative copy there is no stale edit to beat, so a delete is a delete.
 */
import { applyLocally, getTable, write, type WriteOp } from '@/lib/store/records';
import { callSync } from '@/lib/server/config';
import type { BaseRecord, SyncTable } from '@/types';

const DEVICE_KEY = 'paisatrack.deviceId';

/**
 * A stable id for this browser.
 *
 * Vestigial as a sync tiebreaker — there is nothing left to break ties between
 * — but still worth stamping onto records and still shown in Settings, because
 * "which machine did I enter this on" is a question people ask of their own
 * data.
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `dev_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function nowISO(): string {
  return new Date().toISOString();
}

/** Raised when a write is attempted with no server configured. */
export class NoServer extends Error {
  constructor() {
    super('No server is configured. Add one in Settings before entering data.');
    this.name = 'NoServer';
  }
}

function requireServer() {
  const call = callSync();
  if (!call) throw new NoServer();
  return call;
}

/** Send ops to the server, then reflect them in memory. Never the other way round. */
async function commit(ops: WriteOp[], applied: { table: SyncTable; id: string; record?: BaseRecord }[]) {
  await write(requireServer(), ops);
  applyLocally(applied);
}

export async function create<T extends BaseRecord>(
  table: SyncTable,
  idPrefix: string,
  data: Omit<T, 'id' | 'createdAt' | 'updatedAt' | 'deviceId' | 'deletedAt'>,
): Promise<T> {
  const now = nowISO();
  const record = {
    ...data,
    id: newId(idPrefix),
    createdAt: now,
    updatedAt: now,
    deviceId: getDeviceId(),
  } as T;

  await commit(
    [{ tbl: table, id: record.id, data: JSON.stringify(record) }],
    [{ table, id: record.id, record }],
  );
  return record;
}

export async function update<T extends BaseRecord>(
  table: SyncTable,
  id: string,
  patch: Partial<T>,
): Promise<T> {
  const existing = getTable<T>(table).find((r) => r.id === id);
  if (!existing) throw new Error(`No ${table} record with id ${id}.`);

  const record = { ...existing, ...patch, id, updatedAt: nowISO(), deviceId: getDeviceId() } as T;
  await commit([{ tbl: table, id, data: JSON.stringify(record) }], [{ table, id, record }]);
  return record;
}

export async function put<T extends BaseRecord>(table: SyncTable, record: T): Promise<T> {
  const stamped = { ...record, updatedAt: nowISO(), deviceId: getDeviceId() } as T;
  await commit(
    [{ tbl: table, id: stamped.id, data: JSON.stringify(stamped) }],
    [{ table, id: stamped.id, record: stamped }],
  );
  return stamped;
}

/**
 * Delete a record.
 *
 * Really delete it. The signature is kept from the tombstone era so callers did
 * not have to change, but there is no longer a soft-delete to undo.
 */
export async function remove(table: SyncTable, id: string): Promise<void> {
  await commit([{ tbl: table, id }], [{ table, id }]);
}

/** Kept as an alias so older call sites read correctly; both are now the same thing. */
export const hardDelete = remove;

export async function list<T extends BaseRecord>(table: SyncTable): Promise<T[]> {
  return [...getTable<T>(table)];
}

export async function get<T extends BaseRecord>(
  table: SyncTable,
  id: string,
): Promise<T | undefined> {
  return getTable<T>(table).find((r) => r.id === id);
}

/**
 * Write many records at once.
 *
 * One server call per 200 records — the Worker's batch limit, which exists
 * because parsing the request body is the one cost there that scales with
 * payload size against a 10ms CPU budget. The whole set is applied in memory
 * only after every chunk has been accepted, so a failure half way through
 * leaves the UI showing the state the server actually has.
 */
export async function bulkPut<T extends BaseRecord>(
  table: SyncTable,
  records: T[],
  options: { stamp?: boolean } = {},
): Promise<number> {
  if (records.length === 0) return 0;

  const stamp = options.stamp ?? true;
  const now = nowISO();
  const deviceId = getDeviceId();

  const prepared = records.map((r) =>
    stamp ? ({ ...r, updatedAt: r.updatedAt ?? now, deviceId: r.deviceId ?? deviceId } as T) : r,
  );

  await commit(
    prepared.map((r) => ({ tbl: table, id: r.id, data: JSON.stringify(r) })),
    prepared.map((r) => ({ table, id: r.id, record: r })),
  );
  return prepared.length;
}

/**
 * Write across several tables in one go.
 *
 * Added for the import flow and the migration, where a single user action
 * produces records in more than one table and half of them landing is not an
 * acceptable outcome. The Worker applies each batch inside one D1 transaction.
 */
export async function bulkPutMany(
  groups: { table: SyncTable; records: BaseRecord[] }[],
): Promise<number> {
  const ops: WriteOp[] = [];
  const applied: { table: SyncTable; id: string; record?: BaseRecord }[] = [];
  const now = nowISO();
  const deviceId = getDeviceId();

  for (const { table, records } of groups) {
    for (const raw of records) {
      const record = { ...raw, updatedAt: raw.updatedAt ?? now, deviceId: raw.deviceId ?? deviceId };
      ops.push({ tbl: table, id: record.id, data: JSON.stringify(record) });
      applied.push({ table, id: record.id, record });
    }
  }

  if (ops.length === 0) return 0;
  await commit(ops, applied);
  return ops.length;
}
