/**
 * A Worker stand-in for the end-to-end tests.
 *
 * It runs the **real** storage logic — `applyWrites`, `readAll`, `counts` and
 * `wipe` are imported from `worker/src/data.ts`, not reimplemented — over an
 * in-memory map instead of D1. So the JSON the app receives is assembled by the
 * same string concatenation that ships, and a bug in that assembly fails these
 * tests rather than waiting to be found in production.
 *
 * ## Why it namespaces by token
 *
 * Playwright runs `fullyParallel` across two device projects, so a dozen tests
 * share this process. One global dataset would mean each test watching its
 * records change underneath it. Each test generates its own token and gets its
 * own isolated store, which keeps the parallelism and makes every test's
 * fixture genuinely its own.
 *
 * This is a test fixture, not a second implementation of the server. If it ever
 * starts needing behaviour of its own, that is the signal the e2e suite is
 * testing the wrong thing.
 */
import { createServer } from 'node:http';
import { applyWrites, counts, readAll, wipe } from '../worker/src/data.ts';

const PORT = Number(process.env.E2E_SERVER_PORT ?? 8788);

/** token -> that test's rows. */
const datasets = new Map();

function datasetFor(token) {
  let rows = datasets.get(token);
  if (!rows) {
    rows = new Map();
    datasets.set(token, rows);
  }
  return rows;
}

/** The subset of the D1 API that data.ts actually issues. */
function dbFor(rows) {
  const run = (sql, args) => {
    if (/^CREATE/i.test(sql)) return { results: [] };

    if (/^INSERT INTO records/i.test(sql)) {
      const [id, tbl, updated_at, data] = args;
      rows.set(id, { id, tbl, updated_at, data });
      return { results: [] };
    }
    if (/^DELETE FROM records WHERE id/i.test(sql)) {
      rows.delete(args[0]);
      return { results: [] };
    }
    if (/^DELETE FROM records$/i.test(sql.trim())) {
      rows.clear();
      return { results: [] };
    }
    if (/SELECT COUNT\(\*\) AS n FROM records$/i.test(sql.trim())) {
      return { results: [{ n: rows.size }] };
    }
    if (/GROUP BY tbl/i.test(sql)) {
      const totals = new Map();
      for (const r of rows.values()) totals.set(r.tbl, (totals.get(r.tbl) ?? 0) + 1);
      return { results: [...totals].map(([tbl, n]) => ({ tbl, n })) };
    }
    if (/SELECT tbl, data FROM records ORDER BY tbl/i.test(sql)) {
      // ORDER BY is load-bearing for readAll's grouping.
      const sorted = [...rows.values()].sort((a, b) =>
        a.tbl < b.tbl ? -1 : a.tbl > b.tbl ? 1 : 0,
      );
      return { results: sorted.map((r) => ({ tbl: r.tbl, data: r.data })) };
    }
    throw new Error(`e2e server does not know this statement: ${sql}`);
  };

  return {
    prepare: (sql) => ({
      bind: (...args) => ({ all: async () => run(sql, args), run: async () => run(sql, args) }),
      all: async () => run(sql, []),
      run: async () => run(sql, []),
    }),
    batch: async (statements) => {
      for (const s of statements) await s.all();
      return [];
    },
  };
}

const cors = (origin) => ({
  'Access-Control-Allow-Origin': origin ?? '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  Vary: 'Origin',
});

createServer(async (req, res) => {
  const origin = req.headers.origin;
  const url = new URL(req.url, 'http://localhost');
  const send = (code, body) =>
    res
      .writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(origin) })
      .end(body);

  if (req.method === 'OPTIONS') return res.writeHead(204, cors(origin)).end();

  if (url.pathname === '/health') {
    return send(200, JSON.stringify({ ok: true, ai: false, push: false, db: true }));
  }

  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  // Any non-empty token is accepted and becomes its own namespace — the real
  // Worker's auth is covered by worker/src/index.test.ts.
  if (!token) return send(401, JSON.stringify({ error: 'Unauthorised.' }));

  const db = dbFor(datasetFor(token));

  try {
    if (url.pathname === '/data' && req.method === 'GET') return send(200, await readAll(db));

    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : {};

    if (url.pathname === '/data/write') {
      return send(200, JSON.stringify({ ok: true, ...(await applyWrites(db, parsed.ops ?? [])) }));
    }
    if (url.pathname === '/data/counts') return send(200, JSON.stringify({ counts: await counts(db) }));
    if (url.pathname === '/data/wipe') {
      return send(200, JSON.stringify({ ok: true, deleted: await wipe(db) }));
    }
    return send(404, JSON.stringify({ error: 'Not found.' }));
  } catch (e) {
    return send(400, JSON.stringify({ error: e instanceof Error ? e.message : 'failed' }));
  }
}).listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`e2e server on http://localhost:${PORT}`);
});
