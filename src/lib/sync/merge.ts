/**
 * Conflict resolution — pure functions, so the rules are unit-testable without
 * a browser, a database or a network.
 *
 * PaisaTrack is a single-user app across two devices, so genuine conflicts are
 * rare: they need the same record edited on both devices between two syncs.
 * When it does happen we take last-write-wins on `updatedAt`, breaking exact
 * ties with `deviceId` so both devices independently reach the same answer
 * (an arbitrary but *deterministic* winner beats a coin flip that leaves the
 * two devices disagreeing forever).
 *
 * Deletions are tombstones, not absences: a record with `deletedAt` set always
 * beats a record without one at the same timestamp, so a delete on one device
 * is never undone by the other device's stale copy.
 */
import type { BaseRecord, SyncPayload, SyncTable } from '@/types';
import { SYNC_TABLES } from '@/types';

export const SCHEMA_VERSION = 1;

export interface MergeConflict<T extends BaseRecord = BaseRecord> {
  table: SyncTable;
  recordId: string;
  local: T;
  remote: T;
  winner: 'LOCAL' | 'REMOTE';
}

export interface MergeResult<T extends BaseRecord = BaseRecord> {
  merged: T[];
  conflicts: Array<MergeConflict<T>>;
  /** Records the remote had that we did not (or had staler) — these need writing locally. */
  toApplyLocally: T[];
  /** Records we hold that the remote lacks or has staler — these need pushing. */
  toPush: T[];
}

/**
 * Which of two versions of the same record wins?
 *
 * Later `updatedAt` wins. On an exact tie, a tombstone wins over a live record;
 * failing that, the lexicographically larger `deviceId` wins — arbitrary, but
 * identical on both devices, which is the property that matters.
 */
export function pickWinner<T extends BaseRecord>(local: T, remote: T): 'LOCAL' | 'REMOTE' {
  if (local.updatedAt > remote.updatedAt) return 'LOCAL';
  if (remote.updatedAt > local.updatedAt) return 'REMOTE';

  const localDeleted = Boolean(local.deletedAt);
  const remoteDeleted = Boolean(remote.deletedAt);
  if (localDeleted !== remoteDeleted) return localDeleted ? 'LOCAL' : 'REMOTE';

  const localDevice = local.deviceId ?? '';
  const remoteDevice = remote.deviceId ?? '';
  if (localDevice === remoteDevice) return 'LOCAL'; // same device: nothing to resolve
  return localDevice > remoteDevice ? 'LOCAL' : 'REMOTE';
}

/** Did the two versions actually differ in anything the user would notice? */
function materiallyDifferent<T extends BaseRecord>(a: T, b: T): boolean {
  const strip = (r: T) => {
    const { updatedAt: _u, deviceId: _d, ...rest } = r;
    return JSON.stringify(rest, Object.keys(rest).sort());
  };
  return strip(a) !== strip(b);
}

/** Merge one table's worth of records. */
export function mergeTable<T extends BaseRecord>(
  table: SyncTable,
  local: T[],
  remote: T[],
): MergeResult<T> {
  const localById = new Map(local.map((r) => [r.id, r]));
  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const allIds = new Set([...localById.keys(), ...remoteById.keys()]);

  const merged: T[] = [];
  const conflicts: Array<MergeConflict<T>> = [];
  const toApplyLocally: T[] = [];
  const toPush: T[] = [];

  for (const id of allIds) {
    const l = localById.get(id);
    const r = remoteById.get(id);

    if (l && !r) {
      merged.push(l);
      toPush.push(l);
      continue;
    }
    if (!l && r) {
      merged.push(r);
      toApplyLocally.push(r);
      continue;
    }
    if (!l || !r) continue;

    const winner = pickWinner(l, r);
    const chosen = winner === 'LOCAL' ? l : r;
    merged.push(chosen);

    if (winner === 'REMOTE') toApplyLocally.push(r);
    else if (l.updatedAt !== r.updatedAt) toPush.push(l);

    // Only call it a conflict if both sides were genuinely edited differently.
    if (materiallyDifferent(l, r) && l.updatedAt !== r.updatedAt) {
      conflicts.push({ table, recordId: id, local: l, remote: r, winner });
    }
  }

  return { merged, conflicts, toApplyLocally, toPush };
}

export interface FullMergeResult {
  merged: Record<SyncTable, BaseRecord[]>;
  conflicts: MergeConflict[];
  toApplyLocally: Record<SyncTable, BaseRecord[]>;
  hasLocalChanges: boolean;
}

/** Merge the whole payload, table by table. */
export function mergePayloads(
  local: Record<SyncTable, BaseRecord[]>,
  remote: Record<SyncTable, BaseRecord[]>,
): FullMergeResult {
  const merged = {} as Record<SyncTable, BaseRecord[]>;
  const toApplyLocally = {} as Record<SyncTable, BaseRecord[]>;
  const conflicts: MergeConflict[] = [];
  let hasLocalChanges = false;

  for (const table of SYNC_TABLES) {
    const result = mergeTable(table, local[table] ?? [], remote[table] ?? []);
    merged[table] = result.merged;
    toApplyLocally[table] = result.toApplyLocally;
    conflicts.push(...result.conflicts);
    if (result.toPush.length > 0) hasLocalChanges = true;
  }

  return { merged, conflicts, toApplyLocally, hasLocalChanges };
}

/** Build the data.json body. Records are id-sorted so git diffs stay readable. */
export function buildPayload(
  data: Record<SyncTable, BaseRecord[]>,
  deviceId: string,
): SyncPayload {
  const sorted = {} as Record<SyncTable, BaseRecord[]>;
  for (const table of SYNC_TABLES) {
    sorted[table] = [...(data[table] ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    deviceId,
    data: sorted,
  };
}

export function serialisePayload(payload: SyncPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parse and validate a data.json.
 *
 * Delegates to lib/validation, which drops individual malformed records rather
 * than rejecting the whole file — one corrupt expense is recoverable, a refused
 * backup is not. Anything dropped is reported so it is never silent.
 *
 * The validator is imported on demand because it pulls in Zod (~20 kB gzipped),
 * and nothing on first paint parses a payload — this only runs on a sync pull
 * or a restore. A static import put the whole of Zod in the app shell.
 */
export async function parsePayload(
  text: string,
): Promise<SyncPayload & { dropped: number; problems: string[] }> {
  const { parseAndValidatePayload } = await import('@/lib/validation');
  const result = parseAndValidatePayload(text);

  const data = {} as Record<SyncTable, BaseRecord[]>;
  for (const table of SYNC_TABLES) {
    data[table] = (result.data[table] ?? []) as BaseRecord[];
  }

  return {
    schemaVersion: result.schemaVersion,
    exportedAt: result.exportedAt,
    deviceId: result.deviceId,
    data,
    dropped: result.dropped,
    problems: result.problems,
  };
}

/** A human-readable commit message, so the git log is actually useful. */
export function commitMessage(
  counts: Partial<Record<SyncTable, number>>,
  deviceId: string,
): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([table, n]) => `${n} ${table}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes';
  return `sync: ${summary} [${deviceId}]`;
}
