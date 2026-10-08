/**
 * The Worker's routing, auth and input validation.
 *
 * The handler is exercised directly with a fake `env` rather than through
 * `wrangler dev`, which needs a TTY and reaches out to Cloudflare for the AI
 * binding. Everything worth testing here is independent of workerd: whether an
 * unauthenticated request gets in, whether a wrong token gets in, whether a
 * payee name can be smuggled into the push schedule, and whether the page cap
 * holds.
 *
 * What this deliberately does NOT test is inference itself. That needs a real
 * account and real neurons, and a mocked model would only assert that the mock
 * returns what the mock was told to return.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import handler from './index';

const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaa';
const ORIGIN = 'https://j5pecter.github.io';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/fake-test-endpoint';

/** Just enough KV for the handler: get(json), put, delete, list. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string, type?: string) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

let env: Record<string, unknown>;

beforeEach(() => {
  env = {
    AI: { run: async () => ({ response: 'unused' }) },
    PUSH: fakeKv(),
    API_TOKEN: TOKEN,
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:4180`,
    VAPID_PUBLIC_KEY: 'B'.repeat(87),
    VAPID_PRIVATE_JWK: '{}',
    VAPID_SUBJECT: 'mailto:test@example.com',
  };
});

async function call(
  path: string,
  init: RequestInit & { origin?: string; token?: string | null } = {},
) {
  const { origin = ORIGIN, token, ...rest } = init;
  const headers: Record<string, string> = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (rest.body) headers['Content-Type'] = 'application/json';

  const response = await handler.fetch(
    new Request(`https://worker.test${path}`, { ...rest, headers: { ...headers, ...(rest.headers as object) } }),
    env as never,
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

describe('public routes', () => {
  it('reports health without a token, so setup can be checked', async () => {
    const r = await call('/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ai: true, push: true });
  });

  it('says when the AI binding is missing rather than failing later', async () => {
    env.AI = undefined;
    const r = await call('/health');
    expect(r.body).toMatchObject({ ai: false });
  });

  it('serves the public VAPID key unauthenticated', async () => {
    // Public by definition — the browser needs it to subscribe at all, and
    // putting it behind the token would only make setup harder.
    const r = await call('/push/key');
    expect(r.status).toBe(200);
    expect(r.body?.key).toBe('B'.repeat(87));
  });
});

describe('authentication', () => {
  it('refuses a request with no token', async () => {
    const r = await call('/ocr', { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const r = await call('/ocr', { method: 'POST', body: '{}', token: 'wrong' });
    expect(r.status).toBe(401);
  });

  it('refuses a token that is a prefix of the real one', async () => {
    // The comparison is length-checked first and then constant-time, so a
    // near-miss must not be distinguishable from a complete miss.
    const r = await call('/ocr', { method: 'POST', body: '{}', token: TOKEN.slice(0, -1) });
    expect(r.status).toBe(401);
  });

  it('accepts the right token', async () => {
    const r = await call('/ocr', { method: 'POST', body: '{}', token: TOKEN });
    expect(r.status).not.toBe(401);
  });
});

describe('CORS', () => {
  it('echoes an allowed origin on a preflight', async () => {
    const r = await call('/health', { method: 'OPTIONS' });
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('never echoes an origin that is not on the list', async () => {
    const r = await call('/health', { origin: 'https://evil.example.com' });
    expect(r.headers.get('Access-Control-Allow-Origin')).not.toBe('https://evil.example.com');
  });

  it('varies on Origin, so a CDN cannot serve one origin’s headers to another', async () => {
    const r = await call('/health');
    expect(r.headers.get('Vary')).toBe('Origin');
  });
});

describe('/ocr input handling', () => {
  it('rejects a body with no image', async () => {
    const r = await call('/ocr', { method: 'POST', body: JSON.stringify({}), token: TOKEN });
    expect(r.status).toBe(400);
  });

  it('rejects a non-JSON body', async () => {
    const r = await call('/ocr', { method: 'POST', body: 'not json', token: TOKEN });
    expect(r.status).toBe(400);
  });

  it('caps a request at ten pages', async () => {
    // One bad call must not be able to spend a whole day's neuron allowance.
    const r = await call('/ocr', {
      method: 'POST',
      body: JSON.stringify({ pages: Array(11).fill('AAAA') }),
      token: TOKEN,
    });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toMatch(/10 pages/);
  });

  it('passes the base64 through untouched', async () => {
    let seen: unknown = null;
    env.AI = {
      run: async (_model: string, input: { image: string; prompt: string }) => {
        seen = input.image;
        return { response: '01/04/2026 SALARY 85,000.00 85,000.00' };
      },
    };
    const r = await call('/ocr', {
      method: 'POST',
      body: JSON.stringify({ image: 'QUJD' }),
      token: TOKEN,
    });
    expect(r.status).toBe(200);
    // Not decoded, not re-encoded, not converted to a byte array — all of which
    // would cost more CPU than the free plan's 10ms budget allows.
    expect(seen).toBe('QUJD');
    expect(r.body?.lines).toEqual(['01/04/2026 SALARY 85,000.00 85,000.00']);
  });

  it('reports a page the model failed on instead of silently dropping it', async () => {
    let page = 0;
    env.AI = {
      run: async () => {
        page++;
        if (page === 2) throw new Error('model unavailable');
        return { response: `row from page ${page}` };
      },
    };
    const r = await call('/ocr', {
      method: 'POST',
      body: JSON.stringify({ pages: ['a', 'b', 'c'] }),
      token: TOKEN,
    });
    expect(r.status).toBe(200);
    // A missing page in the middle of a statement is a hole the user will
    // find when reconciling and cannot explain. It has to be said out loud.
    expect(r.body?.failures).toHaveLength(1);
    expect(String((r.body?.failures as string[])[0])).toMatch(/Page 2/);
    expect(r.body?.lines).toHaveLength(2);
  });

  it('is an error, not an empty success, when nothing was read', async () => {
    env.AI = { run: async () => ({ response: '   \n  \n' }) };
    const r = await call('/ocr', {
      method: 'POST',
      body: JSON.stringify({ image: 'QUJD' }),
      token: TOKEN,
    });
    expect(r.status).toBe(502);
  });
});

describe('/push/subscribe stores dates and only dates', () => {
  it('keeps well-formed dates and discards everything else', async () => {
    /*
      The containment test. If a future change widens this field, a payee name
      or a rupee figure reaches a third-party server — which is the one thing
      the reminder design exists to prevent.
    */
    const r = await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({
        endpoint: ENDPOINT,
        dates: ['2026-10-18', '2026-11-02', 'not-a-date', '₹24,500 HDFC Regalia', '18/10/2026'],
      }),
    });

    expect(r.status).toBe(200);
    expect(r.body?.dates).toBe(2);

    const stored = JSON.stringify([...(env.PUSH as ReturnType<typeof fakeKv>).store.values()]);
    expect(stored).not.toContain('HDFC');
    expect(stored).not.toContain('24,500');
    expect(stored).not.toContain('not-a-date');
  });

  it('clamps an out-of-range lead time', async () => {
    const r = await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-18'], leadDays: 9999 }),
    });
    expect(r.body?.leadDays).toBe(3);
  });

  it('refuses an endpoint that is not https', async () => {
    const r = await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: 'http://attacker.example.com/x' }),
    });
    expect(r.status).toBe(400);
  });

  it('does not re-notify about a date it has already announced', async () => {
    const kv = env.PUSH as ReturnType<typeof fakeKv>;

    await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-18', '2026-11-02'] }),
    });

    // Pretend the cron has already sent one for the 18th.
    const key = [...kv.store.keys()][0];
    const record = JSON.parse(kv.store.get(key)!);
    record.notified = ['2026-10-18'];
    kv.store.set(key, JSON.stringify(record));

    // Re-uploading the schedule, which the app does on every open, must not
    // reset that — or the user gets the same reminder every single morning.
    await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-18', '2026-11-02'] }),
    });

    expect(JSON.parse(kv.store.get(key)!).notified).toEqual(['2026-10-18']);
  });

  it('forgets a notification for a date that is no longer in the schedule', async () => {
    const kv = env.PUSH as ReturnType<typeof fakeKv>;

    await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-18'] }),
    });
    const key = [...kv.store.keys()][0];
    const record = JSON.parse(kv.store.get(key)!);
    record.notified = ['2026-10-18'];
    kv.store.set(key, JSON.stringify(record));

    // The bill moved. The old date should not linger as a permanent tombstone.
    await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-25'] }),
    });

    expect(JSON.parse(kv.store.get(key)!).notified).toEqual([]);
  });

  it('deletes the record on unsubscribe', async () => {
    const kv = env.PUSH as ReturnType<typeof fakeKv>;
    await call('/push/subscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT, dates: ['2026-10-18'] }),
    });
    expect(kv.store.size).toBe(1);

    await call('/push/unsubscribe', {
      method: 'POST',
      token: TOKEN,
      body: JSON.stringify({ endpoint: ENDPOINT }),
    });
    expect(kv.store.size).toBe(0);
  });
});

describe('routing', () => {
  it('404s an unknown route', async () => {
    const r = await call('/anything', { method: 'POST', body: '{}', token: TOKEN });
    expect(r.status).toBe(404);
  });

  it('405s a GET on a POST-only route', async () => {
    const r = await call('/ocr', { method: 'GET', token: TOKEN });
    expect(r.status).toBe(405);
  });
});
