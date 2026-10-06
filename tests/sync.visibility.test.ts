/**
 * The data repo must be private, and must stay private.
 *
 * This file exists because of a real defect. `testConnection` used to return
 * `ok: true` for a PUBLIC repo with the warning buried in its `message`. The
 * caller gates on `ok`, so the token was saved and `syncEngine.start()` pushed
 * within seconds — salary, card limits, outstanding balances and every expense
 * row, into a world-readable repo, while the UI showed a green tick and a
 * "Sync connected" toast. `repoPrivate` was returned but read by nothing.
 *
 * Publishing that is irreversible, so these tests treat a public repo as a
 * refusal rather than a warning, and assert that nothing can be saved or
 * pushed when it is.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Octokit is reached through a dynamic `import('@octokit/rest')`, so mocking
 * the module intercepts it. `vi.mock` is hoisted above the imports, hence
 * `vi.hoisted` for the state the factory closes over.
 */
const state = vi.hoisted(() => ({
  repo: { private: true, permissions: { push: true } } as {
    private: boolean;
    permissions: { push: boolean };
  },
  throwOnRepoGet: null as { status?: number; message?: string } | null,
  repoGetCalls: 0,
}));

vi.mock('@octokit/rest', () => ({
  Octokit: class {
    users = {
      getAuthenticated: async () => ({ data: { login: 'tester' } }),
    };
    repos = {
      get: async () => {
        state.repoGetCalls += 1;
        if (state.throwOnRepoGet) throw state.throwOnRepoGet;
        return { data: state.repo };
      },
    };
  },
}));

const { isRepoPrivate, testConnection } = await import('@/lib/github/client');

const config = {
  // Deliberately not token-shaped: a realistic-looking credential in source
  // trips the secret scanner, and a scanner people learn to ignore is worse
  // than none. The Octokit mock never inspects it.
  token: 'fake-token-never-sent-anywhere',
  owner: 'someone',
  repo: 'paisatrack-data',
  path: 'data.json',
  branch: 'main',
};

beforeEach(() => {
  state.repo = { private: true, permissions: { push: true } };
  state.throwOnRepoGet = null;
  state.repoGetCalls = 0;
});

describe('testConnection', () => {
  it('connects to a private, writable repo', async () => {
    const r = await testConnection(config);
    expect(r.ok).toBe(true);
    expect(r.repoPrivate).toBe(true);
    expect(r.login).toBe('tester');
  });

  it('REFUSES a public repo instead of warning about it', async () => {
    state.repo = { private: false, permissions: { push: true } };
    const r = await testConnection(config);

    // ok:false is the whole point — Settings saves the token and starts the
    // engine on `res.ok` alone, so anything else leaks the data.
    expect(r.ok).toBe(false);
    expect(r.repoPrivate).toBe(false);
    expect(r.message).toMatch(/PUBLIC/);
    expect(r.message).toMatch(/private/i);
  });

  it('refuses a public repo even when the token can write to it', async () => {
    // Write access is what makes this dangerous rather than merely useless.
    state.repo = { private: false, permissions: { push: true } };
    const r = await testConnection(config);
    expect(r.ok).toBe(false);
    expect(r.canWrite).toBe(true);
  });

  it('still refuses a read-only private repo, for a different reason', async () => {
    state.repo = { private: true, permissions: { push: false } };
    const r = await testConnection(config);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cannot write/i);
  });

  it('reports a rejected token distinctly from a visibility refusal', async () => {
    state.throwOnRepoGet = { status: 401 };
    const r = await testConnection(config);
    expect(r.ok).toBe(false);
    expect(r.repoPrivate).toBeUndefined();
    expect(r.message).toMatch(/token/i);
  });
});

describe('isRepoPrivate', () => {
  it('reports true for a private repo', async () => {
    expect(await isRepoPrivate(config)).toBe(true);
  });

  it('reports false once a repo has been made public', async () => {
    state.repo = { private: false, permissions: { push: true } };
    expect(await isRepoPrivate(config)).toBe(false);
  });

  it('reports null — not false — when it cannot find out', async () => {
    // The engine treats null as "unknown" and keeps running; returning false
    // here would stop sync dead every time the network blipped.
    state.throwOnRepoGet = { status: 500, message: 'upstream' };
    expect(await isRepoPrivate(config)).toBeNull();
  });

  it('reports null when offline rather than throwing', async () => {
    state.throwOnRepoGet = { message: 'network error' };
    await expect(isRepoPrivate(config)).resolves.toBeNull();
  });
});
