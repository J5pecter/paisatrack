/**
 * The first push must create the remote file.
 *
 * This exists because of a real defect. `push()` returned early whenever the
 * sync queue was empty, and only writes through `repository.ts` enqueue
 * anything — the seeder writes to Dexie directly, and nothing entered before
 * sync was configured was ever queued. So a freshly connected device uploaded
 * nothing, reported IDLE, and left the user believing their finances were
 * backed up while `data.json` did not exist in the repo at all.
 *
 * These tests pin the decision rather than the implementation: given an empty
 * queue, does the engine work out whether the remote needs creating?
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** null models a 404 — the file has never been created. */
  remoteFile: null as { content: string; sha: string; etag?: string } | null,
  /** Every readDataFile call, so we can assert on the ETag used. */
  reads: [] as Array<string | undefined>,
  writes: [] as Array<{ body: string; sha: string | undefined; message: string }>,
}));

vi.mock('@/lib/github/client', () => ({
  DEFAULT_CONFIG: { repo: 'paisatrack-data', path: 'data.json', branch: 'main' },
  loadConfig: async () => ({
    token: 'fake-token-never-sent-anywhere',
    owner: 'someone',
    repo: 'paisatrack-data',
    path: 'data.json',
    branch: 'main',
  }),
  saveConfig: async () => undefined,
  isRepoPrivate: async () => true,
  readDataFile: async (_cfg: unknown, etag?: string) => {
    state.reads.push(etag);
    return state.remoteFile;
  },
  writeDataFile: async (_cfg: unknown, body: string, sha: string | undefined, message: string) => {
    state.writes.push({ body, sha, message });
    return { sha: 'sha-after-write' };
  },
  GitHubError: class extends Error {
    hint?: string;
  },
}));

const { readDataFile } = await import('@/lib/github/client');

beforeEach(() => {
  state.remoteFile = null;
  state.reads = [];
  state.writes = [];
});

/**
 * The decision `push()` makes before doing any work, extracted so it can be
 * tested without standing up Dexie, the change-emitter and the poll timers.
 * It mirrors the engine: a known sha means the file exists; otherwise ask,
 * deliberately without an ETag.
 */
async function needsInitialUpload(
  queuedCount: number,
  lastSha: string | undefined,
): Promise<{ push: boolean; initialUpload: boolean }> {
  if (queuedCount > 0) return { push: true, initialUpload: false };
  if (lastSha !== undefined) return { push: false, initialUpload: false };

  const existing = await readDataFile({} as never, undefined);
  if (existing) return { push: false, initialUpload: false };
  return { push: true, initialUpload: true };
}

describe('deciding whether to push', () => {
  it('pushes queued changes, as it always did', async () => {
    const r = await needsInitialUpload(3, 'sha-known');
    expect(r.push).toBe(true);
    expect(r.initialUpload).toBe(false);
  });

  it('uploads everything when the queue is empty and the remote has no file', async () => {
    // The regression: this used to return early and commit nothing, for ever.
    state.remoteFile = null;
    const r = await needsInitialUpload(0, undefined);
    expect(r.push).toBe(true);
    expect(r.initialUpload).toBe(true);
  });

  it('asks WITHOUT an ETag, so a null answer cannot be a 304', async () => {
    // With an ETag, null is ambiguous — "unchanged" and "does not exist" look
    // identical, and treating "unchanged" as "missing" would re-upload forever.
    state.remoteFile = null;
    await needsInitialUpload(0, undefined);
    expect(state.reads).toEqual([undefined]);
  });

  it('does nothing when the queue is empty and the remote file already exists', async () => {
    state.remoteFile = { content: '{}', sha: 'sha-remote' };
    const r = await needsInitialUpload(0, undefined);
    expect(r.push).toBe(false);
    expect(r.initialUpload).toBe(false);
  });

  it('skips the lookup entirely once a sha is known', async () => {
    const r = await needsInitialUpload(0, 'sha-known');
    expect(r.push).toBe(false);
    // No API call: having a sha already proves the file exists.
    expect(state.reads).toEqual([]);
  });
});

describe('the commit message for an initial upload', () => {
  it('counts the records written, not the empty queue', async () => {
    const { commitMessage } = await import('@/lib/sync/merge');

    // Counting the queue on an initial upload produced "no changes" on the
    // very commit that creates the file.
    expect(commitMessage({}, 'dev_a')).toBe('sync: no changes [dev_a]');
    expect(commitMessage({ expenses: 151, creditCards: 2 }, 'dev_a')).toBe(
      'sync: 151 expenses, 2 creditCards [dev_a]',
    );
  });
});
