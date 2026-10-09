/**
 * The old local database, read once so it can be moved.
 *
 * Until this change PaisaTrack kept everything in IndexedDB. Anyone who used it
 * before has months of real records sitting in a browser store the app no
 * longer reads — and the single worst outcome of moving to a server would be
 * someone opening the new version, seeing an empty dashboard, and concluding
 * their data was gone.
 *
 * So the old database is still openable, by this file and nothing else, for
 * exactly one purpose: copying what is in it to the server.
 *
 * ## Why this uses the raw IndexedDB API and not Dexie
 *
 * Dexie is a schema library: it opens a database at a declared version and
 * reconciles what it finds against what it expects. That is the right thing
 * when you own the schema and entirely the wrong thing here, because this code
 * has to read a database written by *some* older release — v1, v2 or v3, with
 * whatever indexes and key paths that version happened to declare — and a
 * mismatch makes it refuse to open at all. The first test of this against a
 * hand-built old database failed with "UpgradeError: Not yet support for
 * changing primary key", and a user hitting that would have seen an empty
 * dashboard and no migration offer.
 *
 * Opening with `indexedDB.open(name)` and no version never triggers an
 * upgrade; it attaches to whatever is there. Enumerating `objectStoreNames`
 * and calling `getAll()` reads it regardless of shape. There is nothing to
 * mismatch.
 *
 * It also deletes the last reason to ship Dexie at all — ~93 kB that existed
 * purely to read a database on the way out.
 *
 * ## Why it is never written to
 *
 * The old copy is left intact after a migration. If something goes wrong on the
 * server — a bad token, a deleted database, a mistake — the original is still
 * there. Deleting it is a separate, explicit action, and the UI does not offer
 * it until the records are confirmed present on the server.
 */
import { SYNC_TABLES, type BaseRecord, type SyncTable } from '@/types';

export interface LegacyData {
  groups: { table: SyncTable; records: BaseRecord[] }[];
  total: number;
  counts: Record<string, number>;
}

/** Set once the user has migrated or explicitly declined, so they are asked only the once. */
const DISMISS_KEY = 'paisatrack.migrationHandled';

export function migrationHandled(): boolean {
  return localStorage.getItem(DISMISS_KEY) === 'yes';
}

export function markMigrationHandled(): void {
  localStorage.setItem(DISMISS_KEY, 'yes');
}

/**
 * Does an old database exist with anything in it?
 *
 * `indexedDB.databases()` answers without opening anything, so the common case
 * — a new user with no old database — costs one cheap call.
 *
 * Firefox does not implement it. There the answer is "maybe", and the caller
 * falls through to a real open, which is correct and merely not free.
 */
export async function legacyDatabaseExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  if (typeof indexedDB.databases !== 'function') return true;

  try {
    const found = await indexedDB.databases();
    return found.some((d) => d.name === 'paisatrack');
  } catch {
    return false;
  }
}

/** Attach to the existing database, whatever version it is. */
function openLegacy(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // No version argument: attach to whatever exists, never upgrade.
    const request = indexedDB.open('paisatrack');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the old database.'));
    request.onblocked = () => reject(new Error('The old database is open in another tab.'));
  });
}

function readStore(db: IDBDatabase, name: string): Promise<BaseRecord[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(name, 'readonly').objectStore(name).getAll();
    request.onsuccess = () => resolve((request.result ?? []) as BaseRecord[]);
    request.onerror = () => reject(request.error ?? new Error(`Could not read ${name}.`));
  });
}

/**
 * Read everything out of the old database.
 *
 * Tombstones are dropped rather than carried across. They existed so a deletion
 * could propagate through sync and beat a stale edit from another device; there
 * is nothing left to propagate to, and copying them would resurrect rows the
 * user deleted as permanently-hidden clutter in the new store.
 */
export async function readLegacyData(): Promise<LegacyData> {
  const db = await openLegacy();

  try {
    const groups: { table: SyncTable; records: BaseRecord[] }[] = [];
    const counts: Record<string, number> = {};
    let total = 0;

    const present = new Set(Array.from(db.objectStoreNames));

    for (const table of SYNC_TABLES) {
      // A store the old release never created is not an error — that version
      // simply did not have the feature yet.
      if (!present.has(table)) continue;

      const rows = await readStore(db, table);
      const live = rows.filter((r) => !r.deletedAt);
      if (live.length === 0) continue;

      groups.push({ table, records: live });
      counts[table] = live.length;
      total += live.length;
    }

    return { groups, total, counts };
  } finally {
    db.close();
  }
}

/**
 * Delete the old database.
 *
 * Offered only after a migration has been confirmed, and never automatic. The
 * whole value of leaving it in place is that it is the last copy that exists
 * outside the server.
 */
export async function dropLegacyDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('paisatrack');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('The old database could not be deleted.'));
    // Fires when another tab still has it open. Resolving is right: the delete
    // is queued and will complete, and blocking the UI on another tab is worse.
    request.onblocked = () => resolve();
  });
}
