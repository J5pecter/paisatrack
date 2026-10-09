/**
 * Where the Cloudflare Worker lives, and the secret that reaches it.
 *
 * This used to be optional. It is not any more: the app's records live on the
 * Worker, so without this config there is nothing to show. OCR and reminders
 * remain separate opt-ins on top of it, but the URL and token themselves are
 * now the difference between a working app and a setup screen.
 *
 * ## Why localStorage and not IndexedDB
 *
 * Not a style choice. This config is the key to the database, so it cannot
 * live in the database — and the boot path needs it synchronously, before the
 * first request and before React renders anything.
 *
 * ## What the token protects now
 *
 * It began life as a quota guard: something to stop a stranger who found the
 * URL from spending the free neuron budget. It is the lock on the entire
 * financial history now.
 *
 * Anyone holding the unlocked device has it, exactly as before. But anyone
 * holding the *token* has the data from anywhere in the world, which is a
 * materially larger consequence than it was a day ago, and the settings screen
 * says so rather than leaving it implied.
 */
const SETTINGS_KEY = 'paisatrack.worker';

export interface WorkerConfig {
  /** Origin of the deployed Worker, e.g. https://paisatrack.yourname.workers.dev */
  url: string;
  /** Shared secret, matching the Worker's API_TOKEN. */
  token: string;
  /** Opt-in per feature: configuring the Worker does not switch anything on. */
  ocrEnabled: boolean;
  remindersEnabled: boolean;
  /** How many days before a due date to nudge. */
  leadDays: number;
}

export const DEFAULT_WORKER_CONFIG: Omit<WorkerConfig, 'url' | 'token'> = {
  ocrEnabled: false,
  remindersEnabled: false,
  leadDays: 3,
};

/**
 * Read the config synchronously.
 *
 * The async wrappers below exist because every caller already awaits them;
 * this is the one the boot path uses, before React has rendered anything.
 */
export function readWorkerConfig(): WorkerConfig | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WorkerConfig;
    return parsed?.url && parsed?.token ? parsed : null;
  } catch {
    // Corrupt or unavailable storage (private mode, disabled cookies) is a
    // "not configured" state, not a crash on the first paint.
    return null;
  }
}

export async function loadWorkerConfig(): Promise<WorkerConfig | null> {
  return readWorkerConfig();
}

export async function saveWorkerConfig(config: WorkerConfig): Promise<void> {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...config, url: normaliseUrl(config.url) }));
}

export async function clearWorkerConfig(): Promise<void> {
  localStorage.removeItem(SETTINGS_KEY);
}

/**
 * Trailing slashes and stray paths make `${url}/ocr` produce a 404 that looks
 * like a broken Worker rather than a typo.
 */
export function normaliseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * The origin the Content Security Policy must allow, or null.
 *
 * The CSP is baked at build time (see vite.config.ts), so a Worker at an origin
 * the build did not know about will be blocked by the browser however correctly
 * it is configured here. This is what the settings screen checks in order to
 * say so plainly instead of showing an unexplained network error.
 */
export function workerOrigin(url: string): string | null {
  try {
    return new URL(normaliseUrl(url)).origin;
  } catch {
    return null;
  }
}

/** The origin compiled into the CSP, or null if the build had none. */
export function allowedWorkerOrigin(): string | null {
  const configured = import.meta.env.VITE_WORKER_ORIGIN;
  return typeof configured === 'string' && configured.length > 0 ? configured : null;
}

export interface WorkerCall {
  url: string;
  token: string;
}

/** Config for calling the Worker, or null when it is not usable. */
export async function workerCall(): Promise<WorkerCall | null> {
  return callSync();
}

/** The synchronous form, for the boot path and for code that cannot await. */
export function callSync(): WorkerCall | null {
  const config = readWorkerConfig();
  if (!config?.url || !config.token) return null;
  return { url: normaliseUrl(config.url), token: config.token };
}

/**
 * POST JSON to a Worker route.
 *
 * Deliberately not a generic HTTP helper: every call this app makes to the
 * Worker is an authenticated JSON POST to a known route, and keeping it that
 * way means there is exactly one place where the token can be attached.
 */
export async function postToWorker<T>(
  call: WorkerCall,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${call.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${call.token}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let message = `The server returned ${response.status}.`;
    try {
      const parsed = (await response.json()) as { error?: string };
      if (parsed?.error) message = parsed.error;
    } catch {
      // A non-JSON error body is not worth a second failure mode.
    }
    if (response.status === 401) {
      message = 'The server rejected the token. Check it matches the Worker’s API_TOKEN.';
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}
