/**
 * PaisaTrack's server.
 *
 * It holds the data now. That is a change in kind, not degree: until this
 * commit the Worker was an optional accessory and the app's records lived in
 * IndexedDB on whichever device typed them. They live here instead, so the
 * data follows the person rather than the laptop.
 *
 *   GET  /data         Everything, as one JSON document.
 *   POST /data/write   A batch of upserts and deletes.
 *   POST /data/counts  How many records exist, per table.
 *   POST /data/wipe    Delete everything.
 *
 *   POST /ocr          Read a scanned statement with a vision model, when the
 *                      on-device engine has made a mess of it. Stateless — the
 *                      image is held in memory for the length of one request
 *                      and never written anywhere.
 *
 *   POST /push/*       Remember that a device wants reminders, and nudge it
 *                      when a payment is near. The nudge carries NO payload:
 *                      no amount, no payee, no account. Only a date ever
 *                      reaches this Worker, and the app fills in the detail
 *                      locally after the user taps.
 *
 * ## The token is now the lock on everything
 *
 * While the records were local, the trust boundary was the device: the data was
 * as safe as an unlocked phone. It is now reachable at a URL, and `API_TOKEN`
 * is the only thing between a stranger and somebody's complete financial
 * history. It deserves to be long and random, and it must never be committed.
 *
 * ## Why it fits on the free plan
 *
 * Workers Free allows 10ms of **CPU** per request. That is not a speed limit
 * that can be traded for patience — it is a budget for time spent executing,
 * and exceeding it terminates the request. Running Tesseract here would be
 * impossible at any speed.
 *
 * Everything below is therefore I/O-bound by construction. Cloudflare does not
 * count time spent waiting on `fetch()` or on an AI binding, so:
 *
 *   - the image arrives already base64-encoded, so this Worker never converts
 *     it (encoding a megabyte would cost more CPU than the whole budget);
 *   - inference happens on Cloudflare's GPUs via the AI binding, which is a
 *     wait, not work;
 *   - a push is one ECDSA signature — well under a millisecond — plus a POST.
 *
 * ## What it is still not
 *
 * Not an account system, and not multi-tenant. There is one dataset and one
 * token; anyone holding the token is the owner. That is the right shape for a
 * single person's finances and the wrong shape for anything else, and it is the
 * assumption to revisit first if a second user ever appears.
 */
import { applyWrites, counts, ensureSchema, MAX_OPS, readAll, wipe, type WriteOp } from './data';

export interface Env {
  AI: Ai;
  PUSH: KVNamespace;
  /** The records database. See data.ts. */
  DB: D1Database;
  /** Shared secret. Without it this is an open endpoint for burning someone's neuron budget. */
  API_TOKEN: string;
  /** Comma-separated origins allowed to call it. */
  ALLOWED_ORIGINS: string;
  /** VAPID keypair for web push. The private half is a JWK; see scripts/gen-vapid.mjs. */
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_JWK: string;
  /** mailto: address, required by the push spec so a push service can report abuse. */
  VAPID_SUBJECT: string;
}

/** The model transcribes; PaisaTrack's own parser interprets. See TRANSCRIBE below. */
const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

/*
  The prompt is narrow on purpose.

  A vision model asked to "extract the transactions" will happily return
  well-formed JSON containing numbers it invented, rows it merged, and a
  balance it quietly corrected so the column adds up. That failure mode is far
  more dangerous than Tesseract's, which garbles characters into shapes that
  usually look obviously broken.

  So the model is given the narrowest job it can do well — copy the characters
  — and every judgement that follows (which column is a debit, what the running
  balance implies, what category a payee belongs to) is made by the same
  deterministic parser that reads text-layer PDFs. That parser already verifies
  each row against the statement's own arithmetic, which means a hallucinated
  figure fails to reconcile and gets flagged instead of imported.
*/
const TRANSCRIBE = [
  'Transcribe this bank or credit-card statement page exactly as printed.',
  'Output one line per row, keeping the columns in their printed left-to-right order.',
  'Copy every digit, decimal point and separator character-for-character.',
  'Do not calculate, correct, reorder, merge, summarise or omit anything.',
  'If a cell is empty, leave it empty.',
  'Output only the transcription, with no commentary before or after it.',
].join(' ');

function corsHeaders(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const ok = origin && allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] ?? 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

/**
 * Constant-time-ish token comparison.
 *
 * `===` on strings short-circuits at the first differing byte, which leaks the
 * shared secret a character at a time to anyone willing to time the responses.
 * The budget here is one small loop, which is nothing.
 */
function tokenMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function authorised(request: Request, env: Env): boolean {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return token.length > 0 && tokenMatches(token, env.API_TOKEN);
}

// ---------------------------------------------------------------- base64url

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

// -------------------------------------------------------------------- push

/**
 * A VAPID `Authorization` header for one push endpoint.
 *
 * The JWT is audience-bound to the push service's origin and short-lived, so a
 * captured header cannot be replayed against a different service or for long.
 */
async function vapidHeader(endpoint: string, env: Env): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = b64urlText(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64urlText(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
      sub: env.VAPID_SUBJECT,
    }),
  );
  const unsigned = `${header}.${claims}`;

  /*
    Stored as a JWK rather than the raw 32-byte scalar the push ecosystem
    usually passes around. WebCrypto cannot import a bare scalar, and
    reconstructing PKCS#8 by hand-splicing DER is exactly the kind of code that
    works until it silently does not. scripts/gen-vapid.mjs emits the JWK.
  */
  const key = await crypto.subtle.importKey(
    'jwk',
    JSON.parse(env.VAPID_PRIVATE_JWK),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsigned),
  );

  return `vapid t=${unsigned}.${b64url(new Uint8Array(signature))}, k=${env.VAPID_PUBLIC_KEY}`;
}

interface StoredSubscription {
  endpoint: string;
  /** ISO dates (yyyy-mm-dd) on which something is due. Dates only — never amounts. */
  dates: string[];
  /** Dates already notified about, so a daily cron does not nag. */
  notified: string[];
  /** How many days ahead to warn. */
  leadDays: number;
  updated: string;
}

/**
 * Send one content-free push.
 *
 * No body at all — which is not a shortcut but the design. A payload would
 * have to be encrypted here, and to encrypt it this Worker would first have to
 * *hold* it: the amount, the payee, the account. A bodiless push wakes the
 * service worker, which shows a generic notification, and the app fills in the
 * detail from the local database once the user taps it. Cloudflare learns that
 * a device has something due. It never learns what.
 */
async function sendPush(endpoint: string, env: Env): Promise<number> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(endpoint, env),
      TTL: '86400',
      // Required by RFC 8030 for a bodiless push; some services reject without it.
      'Content-Length': '0',
    },
  });
  return response.status;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ------------------------------------------------------------------ routes

async function handleOcr(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { image?: unknown; pages?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400, cors);
  }

  const images = Array.isArray(body.pages)
    ? body.pages
    : typeof body.image === 'string'
      ? [body.image]
      : null;

  if (!images || images.length === 0 || !images.every((i) => typeof i === 'string' && i.length > 0)) {
    return json({ error: 'Send `image` as a base64 string, or `pages` as an array of them.' }, 400, cors);
  }

  // A hard ceiling on one request's share of a 10,000-neuron day. Ten pages is
  // more than any statement worth importing by hand, and it stops one bad call
  // from spending the whole budget.
  if (images.length > 10) {
    return json({ error: 'At most 10 pages per request.' }, 400, cors);
  }

  const lines: string[] = [];
  const failures: string[] = [];

  for (let i = 0; i < images.length; i++) {
    try {
      /*
        The base64 goes straight through. Decoding it here, or rebuilding it as
        the number[] the binding also accepts, would mean touching every byte —
        and a megabyte of that is more CPU than the entire free-plan budget.
      */
      const result = (await env.AI.run(VISION_MODEL, {
        prompt: TRANSCRIBE,
        image: images[i] as string,
        // Enough for a dense statement page. Output tokens are by far the more
        // expensive half of the neuron bill, so this is a cost control too.
        max_tokens: 2048,
        // Transcription is not a creative task. Any sampling temperature is
        // sampling over which digit to write down.
        temperature: 0,
      })) as { response?: string };

      const text = typeof result?.response === 'string' ? result.response : '';
      for (const line of text.split('\n')) {
        if (line.trim().length > 0) lines.push(line);
      }
    } catch (e) {
      failures.push(`Page ${i + 1}: ${e instanceof Error ? e.message : 'inference failed'}`);
    }
  }

  if (lines.length === 0) {
    return json(
      {
        error:
          failures.length > 0
            ? `The model could not read the page. ${failures.join('; ')}`
            : 'The model returned nothing readable.',
      },
      502,
      cors,
    );
  }

  return json({ lines, pages: images.length, failures }, 200, cors);
}

async function handleSubscribe(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { endpoint?: unknown; dates?: unknown; leadDays?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400, cors);
  }

  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!/^https:\/\//.test(endpoint)) {
    return json({ error: 'A push endpoint is required.' }, 400, cors);
  }

  /*
    Dates only, and validated as dates — this endpoint must never become a
    place where a free-text field could smuggle a payee name onto a server.
  */
  const dates = Array.isArray(body.dates)
    ? body.dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 200)
    : [];

  const leadDays =
    typeof body.leadDays === 'number' && body.leadDays >= 0 && body.leadDays <= 14
      ? Math.round(body.leadDays)
      : 3;

  const key = `sub:${b64urlText(endpoint)}`;
  const existing = await env.PUSH.get<StoredSubscription>(key, 'json');

  const record: StoredSubscription = {
    endpoint,
    dates,
    // Keep what we have already said, so re-uploading the schedule on every app
    // open does not re-notify about the same date.
    notified: (existing?.notified ?? []).filter((d) => dates.includes(d)),
    leadDays,
    updated: new Date().toISOString(),
  };

  // 120 days: long enough for the furthest reminder we would ever send, short
  // enough that a device that stops reporting in cleans itself up.
  await env.PUSH.put(key, JSON.stringify(record), { expirationTtl: 120 * 24 * 60 * 60 });

  return json({ ok: true, dates: dates.length, leadDays }, 200, cors);
}

async function handleUnsubscribe(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { endpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400, cors);
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return json({ error: 'A push endpoint is required.' }, 400, cors);

  await env.PUSH.delete(`sub:${b64urlText(endpoint)}`);
  return json({ ok: true }, 200, cors);
}

/** Fire one push immediately, so setup can be verified without waiting a day. */
async function handleTest(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { endpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400, cors);
  }
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  if (!endpoint) return json({ error: 'A push endpoint is required.' }, 400, cors);

  const status = await sendPush(endpoint, env);
  return json({ ok: status >= 200 && status < 300, status }, status < 500 ? 200 : 502, cors);
}

/**
 * Read the whole dataset.
 *
 * One request for everything, because everything is small — a few years of one
 * person's finances is a couple of megabytes — and because a per-table endpoint
 * would mean seventeen round trips to render a dashboard.
 *
 * The body is pre-assembled JSON text from data.ts, handed to Response
 * untouched.
 */
async function handleRead(env: Env, cors: Record<string, string>): Promise<Response> {
  await ensureSchema(env.DB);
  const body = await readAll(env.DB);
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // This is the user's financial history. No shared cache anywhere on the
      // path should be holding a copy of it.
      'Cache-Control': 'no-store',
      ...cors,
    },
  });
}

async function handleWrite(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { ops?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400, cors);
  }

  if (!Array.isArray(body.ops)) return json({ error: 'Expected { ops: [...] }.' }, 400, cors);
  if (body.ops.length > MAX_OPS) {
    return json({ error: `At most ${MAX_OPS} ops per request. Send them in batches.` }, 400, cors);
  }

  await ensureSchema(env.DB);
  try {
    const result = await applyWrites(env.DB, body.ops as WriteOp[]);
    return json({ ok: true, ...result }, 200, cors);
  } catch (e) {
    // A rejected op is a client bug, not a server failure — say which.
    return json({ error: e instanceof Error ? e.message : 'That write was rejected.' }, 400, cors);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(request.url);

    // Unauthenticated, and says nothing about whether the token is right —
    // just enough to confirm the Worker is deployed and its bindings exist.
    if (pathname === '/health') {
      return json(
        {
          ok: true,
          ai: typeof env.AI?.run === 'function',
          push: Boolean(env.VAPID_PUBLIC_KEY),
          db: typeof env.DB?.prepare === 'function',
        },
        200,
        cors,
      );
    }

    // The public half of the VAPID key, which the browser needs to subscribe.
    // Public by definition, so it is not behind the token.
    if (pathname === '/push/key') {
      return json({ key: env.VAPID_PUBLIC_KEY ?? null }, 200, cors);
    }

    // /data is the one authenticated GET: reading the whole dataset has no
    // body to send, and making it a POST purely for symmetry would mean giving
    // up HTTP caching semantics and conditional requests later.
    const readOnly = pathname === '/data' && request.method === 'GET';
    if (!readOnly && request.method !== 'POST') {
      return json({ error: 'Method not allowed.' }, 405, cors);
    }
    if (!authorised(request, env)) return json({ error: 'Unauthorised.' }, 401, cors);

    switch (pathname) {
      case '/data':
        return handleRead(env, cors);
      case '/data/write':
        return handleWrite(request, env, cors);
      case '/data/counts':
        await ensureSchema(env.DB);
        return json({ counts: await counts(env.DB) }, 200, cors);
      case '/data/wipe':
        await ensureSchema(env.DB);
        return json({ ok: true, deleted: await wipe(env.DB) }, 200, cors);
      case '/ocr':
        return handleOcr(request, env, cors);
      case '/push/subscribe':
        return handleSubscribe(request, env, cors);
      case '/push/unsubscribe':
        return handleUnsubscribe(request, env, cors);
      case '/push/test':
        return handleTest(request, env, cors);
      default:
        return json({ error: 'Not found.' }, 404, cors);
    }
  },

  /**
   * Daily sweep: who has something due soon, and have we already said so?
   *
   * Runs once a day rather than hourly because the thing being announced is a
   * calendar date, and because every run costs KV reads out of a free quota.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const today = todayUtc();
        const listed = await env.PUSH.list({ prefix: 'sub:' });

        for (const entry of listed.keys) {
          const record = await env.PUSH.get<StoredSubscription>(entry.name, 'json');
          if (!record) continue;

          const due = record.dates.find((d) => {
            const away = daysBetween(today, d);
            return away >= 0 && away <= record.leadDays && !record.notified.includes(d);
          });
          if (!due) continue;

          const status = await sendPush(record.endpoint, env);

          // 404 and 410 are the push service saying this subscription is dead —
          // the browser was uninstalled, or permission was revoked. Keeping it
          // would mean failing this call every single day forever.
          if (status === 404 || status === 410) {
            await env.PUSH.delete(entry.name);
            continue;
          }

          if (status >= 200 && status < 300) {
            record.notified = [...record.notified, due].slice(-60);
            await env.PUSH.put(entry.name, JSON.stringify(record), {
              expirationTtl: 120 * 24 * 60 * 60,
            });
          }
        }
      })(),
    );
  },
};
