/**
 * Where the optional Cloudflare Worker lives, and the secret that reaches it.
 *
 * Optional is the operative word. Every feature that touches this is an
 * addition to something that already works on the device: statement OCR falls
 * back to the local engine, and reminders simply do not fire. Nothing here is
 * on the path of any figure the app computes, and the app must never behave as
 * though it is.
 *
 * The token is stored beside the GitHub token, in IndexedDB, for the same
 * reason and with the same honesty: anyone holding the unlocked device has it.
 * It is not protecting the user's data — the Worker stores none — it is
 * stopping a stranger who finds the URL from spending the free neuron budget.
 */
import { db } from '@/lib/db/schema';

const SETTINGS_KEY = 'worker';

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

export async function loadWorkerConfig(): Promise<WorkerConfig | null> {
  const row = await db._settings.get(SETTINGS_KEY);
  return (row?.value as WorkerConfig) ?? null;
}

export async function saveWorkerConfig(config: WorkerConfig): Promise<void> {
  await db._settings.put({ key: SETTINGS_KEY, value: { ...config, url: normaliseUrl(config.url) } });
}

export async function clearWorkerConfig(): Promise<void> {
  await db._settings.delete(SETTINGS_KEY);
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
  const config = await loadWorkerConfig();
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
