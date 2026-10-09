/**
 * The backup file format.
 *
 * Lifted out of the old sync engine, which is gone. Last-write-wins merging,
 * conflict detection and the deviceId tiebreaker went with it — all of that
 * existed to reconcile two devices that had both edited offline, and there is
 * one authoritative copy now.
 *
 * What survives is the part that was never about sync: a single JSON document
 * holding every record, which Settings writes to a file you can keep. The
 * server is not a backup. A backup is a copy somewhere the server cannot
 * reach, and this is how you make one.
 */
import type { BaseRecord, SyncPayload, SyncTable } from '@/types';
import { SYNC_TABLES } from '@/types';

export const SCHEMA_VERSION = 1;

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

