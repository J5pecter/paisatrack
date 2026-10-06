/**
 * GitHub-as-backend client.
 *
 * The whole cloud tier of PaisaTrack is one JSON file in a private GitHub repo.
 * Every write is a commit, which means the sync history *is* the backup history:
 * you can restore the app's entire state from any point in the git log.
 *
 * The token lives in IndexedDB on the device and is only ever sent to
 * api.github.com. It is never logged, never put in a URL, and never leaves the
 * browser for anywhere else.
 *
 * A note on reads: the spec suggested polling raw.githubusercontent.com, but
 * that host cannot serve a *private* repo with a bearer token. We use the
 * Contents API instead, with an ETag conditional request — a 304 costs nothing
 * against the 5,000/hour rate limit, so 30-second polling is essentially free.
 */
import type { Octokit as OctokitType } from '@octokit/rest';
import { db } from '@/lib/db/schema';

export interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  /** Path of the data file inside the repo. */
  path: string;
  branch: string;
}

const SETTINGS_KEY = 'github';

export const DEFAULT_CONFIG: Omit<GitHubConfig, 'token' | 'owner'> = {
  repo: 'paisatrack-data',
  path: 'data.json',
  branch: 'main',
};

export async function loadConfig(): Promise<GitHubConfig | null> {
  const row = await db._settings.get(SETTINGS_KEY);
  return (row?.value as GitHubConfig) ?? null;
}

export async function saveConfig(config: GitHubConfig): Promise<void> {
  await db._settings.put({ key: SETTINGS_KEY, value: config });
}

export async function clearConfig(): Promise<void> {
  await db._settings.delete(SETTINGS_KEY);
}

export async function isConfigured(): Promise<boolean> {
  const c = await loadConfig();
  return Boolean(c?.token && c.owner && c.repo);
}

// ---------------------------------------------------------------------------
// UTF-8 safe base64 (the GitHub Contents API is base64 in both directions)
// ---------------------------------------------------------------------------

export function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  // Chunked so a large data.json cannot blow the argument limit of fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBase64(b64: string): string {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Request budget
// ---------------------------------------------------------------------------

/** No single request may hang the sync engine. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Outbound throttle.
 *
 * There is no inbound endpoint here to rate-limit, but there IS an outbound
 * budget worth protecting: GitHub allows 5,000 requests an hour, and a bug that
 * loops would burn it in minutes and lock the user out of their own sync for
 * the rest of the hour.
 *
 * Normal use is roughly 100 requests a day, so these ceilings are far above
 * anything legitimate and only ever bite a runaway.
 */
const MIN_INTERVAL_MS = 250;
const MAX_PER_HOUR = 1_000;

let lastRequestAt = 0;
let hourWindowStart = 0;
let requestsThisHour = 0;

/** Throws rather than queueing: a caller that is looping should find out. */
function assertWithinBudget(): void {
  const now = Date.now();

  if (now - hourWindowStart > 3_600_000) {
    hourWindowStart = now;
    requestsThisHour = 0;
  }

  if (requestsThisHour >= MAX_PER_HOUR) {
    const minutes = Math.ceil((3_600_000 - (now - hourWindowStart)) / 60_000);
    throw new GitHubError(
      `PaisaTrack has made ${MAX_PER_HOUR} GitHub requests in the last hour, which is far more than syncing needs. Pausing for ${minutes} minutes to protect your API quota.`,
      429,
    );
  }

  requestsThisHour += 1;
  lastRequestAt = now;
}

/** Spacing between calls, so a retry storm cannot become a tight loop. */
async function respectMinInterval(): Promise<void> {
  const since = Date.now() - lastRequestAt;
  if (since < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - since));
  }
}

/** Per-request abort signal, so a stalled connection cannot hang sync forever. */
function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/** Current outbound usage, for the Settings screen. */
export function outboundUsage(): { thisHour: number; cap: number } {
  return { thisHour: requestsThisHour, cap: MAX_PER_HOUR };
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/**
 * Octokit is a sizeable dependency and most sessions never touch it (sync is
 * optional), so it is imported on first use rather than bundled into the
 * initial load.
 */
let OctokitCtor: typeof OctokitType | null = null;

async function makeOctokit(token: string): Promise<OctokitType> {
  if (!OctokitCtor) {
    const mod = await import('@octokit/rest');
    OctokitCtor = mod.Octokit;
  }
  return new OctokitCtor({ auth: token, userAgent: 'PaisaTrack' });
}

export interface RemoteFile {
  content: string;
  /** Git blob SHA — required to update the file without clobbering. */
  sha: string;
  etag?: string;
}

/**
 * Is the configured data repo still private?
 *
 * `testConnection` gates the moment someone connects, but visibility can change
 * afterwards — a repo made public a month later would otherwise keep receiving
 * pushes forever. The sync engine re-checks on every start, which costs one API
 * call per app load and is the difference between a mistake that is noticed and
 * one that is not.
 *
 * Returns `null` when the answer is unknown (offline, rate-limited, transient
 * failure). Callers must treat `null` as "do not know", never as "safe".
 */
export async function isRepoPrivate(config: GitHubConfig): Promise<boolean | null> {
  try {
    assertWithinBudget();
    await respectMinInterval();
    const octokit = await makeOctokit(config.token);
    const { data: repo } = await octokit.repos.get({
      owner: config.owner,
      repo: config.repo,
      request: { signal: timeoutSignal() },
    });
    return repo.private;
  } catch {
    return null;
  }
}

/** Verify the token and that the data repo is reachable and writable. */
export async function testConnection(config: GitHubConfig): Promise<{
  ok: boolean;
  login?: string;
  repoPrivate?: boolean;
  canWrite?: boolean;
  message: string;
}> {
  try {
    assertWithinBudget();
    await respectMinInterval();
    const octokit = await makeOctokit(config.token);
    const { data: user } = await octokit.users.getAuthenticated({
      request: { signal: timeoutSignal() },
    });
    const { data: repo } = await octokit.repos.get({
      owner: config.owner,
      repo: config.repo,
      request: { signal: timeoutSignal() },
    });

    const canWrite = Boolean(repo.permissions?.push);
    if (!canWrite) {
      return {
        ok: false,
        login: user.login,
        repoPrivate: repo.private,
        canWrite,
        message: `Token can read ${config.owner}/${config.repo} but cannot write to it. Grant Contents: Read and write.`,
      };
    }

    // A public data repo is a refusal, not a warning.
    //
    // This used to return ok:true with the warning in the message. The caller
    // gates on `ok`, so the token was saved and the first push went out within
    // seconds — salary, card limits, outstanding balances and every expense
    // row, committed to a world-readable repo, with a green tick on screen.
    // Publishing that is irreversible: GitHub caches it, forks and mirrors keep
    // it, and search engines index it long after a delete.
    //
    // There is deliberately no override. Making a repo private takes one click,
    // and no legitimate use of this app needs the alternative.
    if (!repo.private) {
      return {
        ok: false,
        login: user.login,
        repoPrivate: false,
        canWrite,
        message:
          `Refusing to connect: ${config.owner}/${config.repo} is PUBLIC. ` +
          `Syncing would publish your salary, balances and loans to anyone. ` +
          `Make the repo private (Settings → General → Change visibility on GitHub), then connect again.`,
      };
    }

    return {
      ok: true,
      login: user.login,
      repoPrivate: true,
      canWrite,
      message: `Connected as ${user.login}. ${config.owner}/${config.repo} is private — good.`,
    };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err.status === 401) {
      return { ok: false, message: 'Token rejected. Check it has not expired and was copied in full.' };
    }
    if (err.status === 404) {
      return {
        ok: false,
        message: `Repo ${config.owner}/${config.repo} not found, or the token does not have access to it.`,
      };
    }
    return { ok: false, message: err.message ?? 'Could not reach GitHub.' };
  }
}

/**
 * Read the data file.
 *
 * Pass the previous ETag to make the request conditional: GitHub answers 304
 * when nothing changed, which does not count against the rate limit.
 * Returns null when the file does not exist yet (first ever sync) or was
 * unchanged since `etag`.
 */
export async function readDataFile(
  config: GitHubConfig,
  etag?: string,
): Promise<RemoteFile | null> {
  assertWithinBudget();
  await respectMinInterval();
  const octokit = await makeOctokit(config.token);
  try {
    const res = await octokit.repos.getContent({
      owner: config.owner,
      repo: config.repo,
      path: config.path,
      ref: config.branch,
      headers: etag ? { 'If-None-Match': etag } : undefined,
      request: { signal: timeoutSignal() },
    });

    const data = res.data as { content?: string; sha: string; type: string };
    if (Array.isArray(res.data) || data.type !== 'file' || !data.content) {
      throw new GitHubError(`${config.path} is not a file in ${config.owner}/${config.repo}.`);
    }

    return {
      content: decodeBase64(data.content),
      sha: data.sha,
      etag: res.headers.etag as string | undefined,
    };
  } catch (e) {
    const err = e as { status?: number; message?: string; name?: string };
    if (err.status === 304) return null; // unchanged
    if (err.status === 404) return null; // not created yet
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new GitHubError(
        `GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Your data is safe on this device; sync will retry.`,
        408,
      );
    }
    throw new GitHubError(err.message ?? 'Failed to read from GitHub', err.status);
  }
}

/**
 * Commit the data file.
 *
 * `sha` must be the blob SHA we last read. GitHub rejects the write with 409 if
 * someone else committed in the meantime, which is exactly the optimistic
 * concurrency check we want — the caller re-pulls, merges and retries.
 */
export async function writeDataFile(
  config: GitHubConfig,
  content: string,
  sha: string | undefined,
  message: string,
): Promise<{ sha: string }> {
  assertWithinBudget();
  await respectMinInterval();
  const octokit = await makeOctokit(config.token);
  try {
    const res = await octokit.repos.createOrUpdateFileContents({
      owner: config.owner,
      repo: config.repo,
      path: config.path,
      message,
      content: encodeBase64(content),
      branch: config.branch,
      ...(sha ? { sha } : {}),
      request: { signal: timeoutSignal() },
    });
    return { sha: res.data.content?.sha ?? '' };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    if (err.status === 409 || err.status === 422) {
      throw new GitHubError(
        'The remote file changed since we last read it.',
        err.status,
        'CONFLICT',
      );
    }
    if (err.status === 403) {
      throw new GitHubError(
        'GitHub rejected the write. The token may lack Contents: Read and write, or you have hit the rate limit.',
        403,
      );
    }
    if ((err as { name?: string }).name === 'TimeoutError' || (err as { name?: string }).name === 'AbortError') {
      throw new GitHubError(
        `GitHub did not respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Nothing was committed; your data is safe on this device.`,
        408,
      );
    }
    throw new GitHubError(err.message ?? 'Failed to write to GitHub', err.status);
  }
}

/** Remaining API quota, for the settings screen. */
export async function rateLimit(config: GitHubConfig): Promise<{
  remaining: number;
  limit: number;
  resetsAt: Date;
}> {
  const octokit = await makeOctokit(config.token);
  const { data } = await octokit.rateLimit.get();
  return {
    remaining: data.rate.remaining,
    limit: data.rate.limit,
    resetsAt: new Date(data.rate.reset * 1000),
  };
}

/** Recent commits to the data file — the built-in backup history. */
export async function fileHistory(
  config: GitHubConfig,
  limit = 20,
): Promise<Array<{ sha: string; message: string; date: string }>> {
  const octokit = await makeOctokit(config.token);
  const { data } = await octokit.repos.listCommits({
    owner: config.owner,
    repo: config.repo,
    path: config.path,
    sha: config.branch,
    per_page: limit,
  });
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    date: c.commit.author?.date ?? '',
  }));
}

/** Read the data file as it was at a given commit, for restore. */
export async function readAtCommit(config: GitHubConfig, sha: string): Promise<string> {
  const octokit = await makeOctokit(config.token);
  const res = await octokit.repos.getContent({
    owner: config.owner,
    repo: config.repo,
    path: config.path,
    ref: sha,
  });
  const data = res.data as { content?: string };
  if (!data.content) throw new GitHubError(`No content at commit ${sha.slice(0, 7)}`);
  return decodeBase64(data.content);
}
