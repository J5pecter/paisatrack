/**
 * The sync engine.
 *
 * Reads never touch this — they come straight from Dexie. This runs in the
 * background, draining the write queue up to GitHub and pulling remote changes
 * down. If it is offline, broken, or simply not configured, the app carries on
 * working exactly as before; sync is strictly additive.
 *
 * Push is debounced and coalesced: twenty rapid edits become one commit, not
 * twenty. Pull is an ETag-conditional poll, so an unchanged file costs nothing
 * against the rate limit.
 */
import { db } from '@/lib/db/schema';
import { bulkPut, getDeviceId, onLocalChange } from '@/lib/db/repository';
import {
  type GitHubConfig,
  GitHubError,
  loadConfig,
  readDataFile,
  writeDataFile,
} from '@/lib/github/client';
import {
  buildPayload,
  commitMessage,
  mergePayloads,
  parsePayload,
  serialisePayload,
} from './merge';
import type { BaseRecord, SyncTable } from '@/types';
import { SYNC_TABLES } from '@/types';

export type SyncStatus =
  | 'DISABLED'    // no token configured — local-only mode
  | 'IDLE'        // everything is up to date
  | 'SYNCING'
  | 'PENDING'     // queued changes waiting for the debounce
  | 'OFFLINE'
  | 'ERROR';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt?: string;
  pendingCount: number;
  error?: string;
  conflictCount: number;
}

type Listener = (state: SyncState) => void;

const PUSH_DEBOUNCE_MS = 3_000;
const POLL_INTERVAL_MS = 30_000;
const MAX_CONFLICT_RETRIES = 3;

class SyncEngine {
  private state: SyncState = { status: 'DISABLED', pendingCount: 0, conflictCount: 0 };
  private listeners = new Set<Listener>();
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight = false;
  private lastEtag: string | undefined;
  private lastSha: string | undefined;
  private unsubscribeChanges: (() => void) | null = null;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  getState(): SyncState {
    return this.state;
  }

  private setState(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** Start background sync. Safe to call when no token is configured. */
  async start(): Promise<void> {
    if (this.running) return;

    const config = await loadConfig();
    if (!config?.token) {
      this.setState({ status: 'DISABLED' });
      return;
    }

    // Re-check visibility before the boot sync. The repo was private when the
    // token was saved, but that was then: anyone can flip a repo public later
    // and nothing would otherwise stop us pushing their finances into it.
    // A null answer means we could not find out (offline, rate-limited) — in
    // that case carry on, because refusing to sync whenever GitHub is briefly
    // unreachable would be its own kind of broken. Only a definite `false`
    // stops us.
    const { isRepoPrivate } = await import('@/lib/github/client');
    if ((await isRepoPrivate(config)) === false) {
      this.running = false;
      this.setState({
        status: 'ERROR',
        error:
          `Sync stopped: ${config.owner}/${config.repo} is now PUBLIC. ` +
          `Nothing has been pushed. Make it private again, then reconnect in Settings.`,
      });
      return;
    }

    this.running = true;
    const meta = await db._syncMeta.get('__file__');
    this.lastSha = meta?.remoteSha;
    this.setState({ status: 'IDLE', lastSyncedAt: meta?.lastPulledAt });

    await this.refreshPendingCount();
    // A full sync on boot so a device that was closed catches up immediately.
    await this.syncNow();

    this.pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      void this.pull();
    }, POLL_INTERVAL_MS);

    this.unsubscribeChanges = onLocalChange(() => this.notifyChange());

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      window.addEventListener('beforeunload', this.onBeforeUnload);
    }
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pollTimer = null;
    this.pushTimer = null;
    this.unsubscribeChanges?.();
    this.unsubscribeChanges = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('beforeunload', this.onBeforeUnload);
    }
    this.setState({ status: 'DISABLED' });
  }

  private onOnline = (): void => {
    void this.syncNow();
  };

  private onBeforeUnload = (): void => {
    // Best effort: if there is anything queued, try to get it out now.
    if (this.state.pendingCount > 0) void this.push();
  };

  /**
   * Called by the repository after every write. Debounced so a burst of edits
   * becomes a single commit.
   */
  notifyChange(): void {
    if (!this.running) return;
    void this.refreshPendingCount();
    this.setState({ status: 'PENDING' });
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => void this.push(), PUSH_DEBOUNCE_MS);
  }

  private async refreshPendingCount(): Promise<void> {
    const pendingCount = await db._syncQueue.count();
    const conflictCount = await db._syncConflicts.count();
    this.setState({ pendingCount, conflictCount });
  }

  /** Pull, merge, then push — the full round trip. */
  async syncNow(): Promise<void> {
    await this.pull();
    await this.push();
  }

  /** Read every live record out of Dexie, keyed by table. */
  private async snapshotLocal(): Promise<Record<SyncTable, BaseRecord[]>> {
    const out = {} as Record<SyncTable, BaseRecord[]>;
    for (const table of SYNC_TABLES) {
      // Tombstones are included on purpose: they must travel to the other device.
      out[table] = (await (db[table] as never as { toArray(): Promise<BaseRecord[]> }).toArray());
    }
    return out;
  }

  private async applyRemote(toApply: Record<SyncTable, BaseRecord[]>): Promise<number> {
    let applied = 0;
    for (const table of SYNC_TABLES) {
      const rows = toApply[table];
      if (!rows?.length) continue;
      // skipSync: these came *from* the remote, re-queueing them would loop.
      await bulkPut(table, rows, { skipSync: true });
      applied += rows.length;
    }
    return applied;
  }

  /** Fetch the remote file and merge anything newer into the local database. */
  async pull(): Promise<{ applied: number; conflicts: number } | null> {
    if (this.inFlight) return null;
    const config = await loadConfig();
    if (!config?.token) return null;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState({ status: 'OFFLINE' });
      return null;
    }

    this.inFlight = true;
    this.setState({ status: 'SYNCING' });

    try {
      const remote = await readDataFile(config, this.lastEtag);
      if (!remote) {
        // 304 (unchanged) or 404 (never created) — neither is an error.
        this.setState({ status: this.state.pendingCount > 0 ? 'PENDING' : 'IDLE', error: undefined });
        return { applied: 0, conflicts: 0 };
      }

      this.lastEtag = remote.etag;
      this.lastSha = remote.sha;

      const remotePayload = await parsePayload(remote.content);
      const local = await this.snapshotLocal();
      const { toApplyLocally, conflicts } = mergePayloads(local, remotePayload.data);

      const applied = await this.applyRemote(toApplyLocally);

      if (conflicts.length > 0) {
        await db._syncConflicts.bulkAdd(
          conflicts.map((c) => ({
            table: c.table,
            recordId: c.recordId,
            localValue: c.local,
            remoteValue: c.remote,
            resolvedAs: c.winner,
            resolvedAt: new Date().toISOString(),
          })),
        );
      }

      const now = new Date().toISOString();
      await db._syncMeta.put({ table: '__file__', lastPulledAt: now, remoteSha: remote.sha });

      await this.refreshPendingCount();
      this.setState({
        status: this.state.pendingCount > 0 ? 'PENDING' : 'IDLE',
        lastSyncedAt: now,
        error: undefined,
      });
      return { applied, conflicts: conflicts.length };
    } catch (e) {
      this.handleError(e);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  /**
   * Commit the local state.
   *
   * On a 409 the remote moved under us: re-read, merge, and try again. Three
   * attempts is plenty for a single-user app; beyond that something is wrong
   * and we surface it rather than spinning.
   */
  async push(attempt = 0): Promise<{ committed: boolean } | null> {
    if (this.inFlight) return null;
    const config = await loadConfig();
    if (!config?.token) return null;

    const queued = await db._syncQueue.toArray();
    if (queued.length === 0) {
      this.setState({ status: 'IDLE' });
      return { committed: false };
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.setState({ status: 'OFFLINE' });
      return null;
    }

    this.inFlight = true;
    this.setState({ status: 'SYNCING' });

    try {
      const local = await this.snapshotLocal();

      // Fold in whatever is on the remote so we never overwrite the other
      // device's work with our own snapshot.
      const remote = await readDataFile(config, undefined);
      let merged = local;
      if (remote) {
        const remotePayload = await parsePayload(remote.content);
        const result = mergePayloads(local, remotePayload.data);
        merged = result.merged;
        await this.applyRemote(result.toApplyLocally);
        this.lastSha = remote.sha;
        this.lastEtag = remote.etag;
      }

      const counts: Partial<Record<SyncTable, number>> = {};
      for (const item of queued) counts[item.table] = (counts[item.table] ?? 0) + 1;

      const deviceId = getDeviceId();
      const body = serialisePayload(buildPayload(merged, deviceId));
      const { sha } = await writeDataFile(
        config,
        body,
        this.lastSha,
        commitMessage(counts, deviceId),
      );

      this.lastSha = sha;
      this.lastEtag = undefined; // force a fresh read next poll

      // Only clear the items we actually committed — anything queued during the
      // request stays for the next round.
      const committedIds = queued.map((q) => q.id!).filter((id) => id != null);
      await db._syncQueue.bulkDelete(committedIds);

      const now = new Date().toISOString();
      await db._syncMeta.put({ table: '__file__', lastPushedAt: now, remoteSha: sha });

      await this.refreshPendingCount();
      this.setState({ status: 'IDLE', lastSyncedAt: now, error: undefined });
      return { committed: true };
    } catch (e) {
      if (e instanceof GitHubError && e.hint === 'CONFLICT' && attempt < MAX_CONFLICT_RETRIES) {
        this.inFlight = false;
        this.lastSha = undefined;
        this.lastEtag = undefined;
        return this.push(attempt + 1);
      }
      this.handleError(e);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  private handleError(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    const offline = typeof navigator !== 'undefined' && !navigator.onLine;
    this.setState({
      status: offline ? 'OFFLINE' : 'ERROR',
      error: message,
    });
  }

  /** Discard local state and take the remote wholesale. Destructive. */
  async forcePullFromRemote(): Promise<number> {
    const config = await loadConfig();
    if (!config?.token) throw new Error('GitHub is not configured.');

    const remote = await readDataFile(config);
    if (!remote) throw new Error('There is no data.json in the repo yet.');

    const payload = await parsePayload(remote.content);
    let applied = 0;
    for (const table of SYNC_TABLES) {
      const rows = payload.data[table] ?? [];
      await (db[table] as never as { clear(): Promise<void> }).clear();
      await bulkPut(table, rows as BaseRecord[], { skipSync: true });
      applied += rows.length;
    }
    await db._syncQueue.clear();
    this.lastSha = remote.sha;
    this.lastEtag = remote.etag;
    await this.refreshPendingCount();
    return applied;
  }

  /** Overwrite the remote with local state, ignoring what is there. Destructive. */
  async forcePushToRemote(): Promise<void> {
    const config = await loadConfig();
    if (!config?.token) throw new Error('GitHub is not configured.');

    const local = await this.snapshotLocal();
    const deviceId = getDeviceId();
    const remote = await readDataFile(config);
    const body = serialisePayload(buildPayload(local, deviceId));
    const { sha } = await writeDataFile(
      config,
      body,
      remote?.sha,
      `sync: force push from ${deviceId}`,
    );
    this.lastSha = sha;
    this.lastEtag = undefined;
    await db._syncQueue.clear();
    await this.refreshPendingCount();
    this.setState({ status: 'IDLE', lastSyncedAt: new Date().toISOString() });
  }
}

export const syncEngine = new SyncEngine();

/** Config to hand back to the UI after the user saves a token. */
export async function reconfigure(config: GitHubConfig): Promise<void> {
  syncEngine.stop();
  const { saveConfig } = await import('@/lib/github/client');
  await saveConfig(config);
  await syncEngine.start();
}
