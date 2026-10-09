/**
 * The records store.
 *
 * The thing most worth testing here is `readAll`, because it builds JSON by
 * **string concatenation** rather than `JSON.stringify` — a deliberate choice
 * to stay inside the free plan's 10ms CPU budget, and one that trades a safe
 * API for a fast one. Concatenation cannot be type-checked into correctness:
 * a missing comma or an unclosed bracket produces a body that parses nowhere
 * and fails at the client as "Unexpected end of JSON input". So every shape
 * that matters — empty, one table, several tables, one row, many — is parsed
 * back here and compared.
 *
 * The D1 fake below implements only the handful of statements this module
 * actually issues. It is not a SQL engine and is not pretending to be one; it
 * exists so that routing, validation and the JSON assembly can be tested
 * without a Cloudflare account. The SQL itself is exercised on first deploy.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { applyWrites, counts, ensureSchema, readAll, wipe, MAX_OPS } from './data';

interface Row {
  id: string;
  tbl: string;
  updated_at: string;
  data: string;
}

function fakeD1() {
  const rows = new Map<string, Row>();

  const run = (sql: string, args: unknown[]) => {
    if (/^CREATE/i.test(sql)) return { results: [] };

    if (/^INSERT INTO records/i.test(sql)) {
      const [id, tbl, updated_at, data] = args as string[];
      rows.set(id, { id, tbl, updated_at, data });
      return { results: [] };
    }

    if (/^DELETE FROM records WHERE id/i.test(sql)) {
      rows.delete(args[0] as string);
      return { results: [] };
    }

    if (/^DELETE FROM records$/i.test(sql.trim())) {
      rows.clear();
      return { results: [] };
    }

    if (/SELECT COUNT\(\*\) AS n FROM records$/i.test(sql.trim())) {
      return { results: [{ n: rows.size }] };
    }

    if (/SELECT tbl, COUNT\(\*\) AS n FROM records GROUP BY tbl/i.test(sql)) {
      const out = new Map<string, number>();
      for (const r of rows.values()) out.set(r.tbl, (out.get(r.tbl) ?? 0) + 1);
      return { results: [...out].map(([tbl, n]) => ({ tbl, n })) };
    }

    if (/SELECT tbl, data FROM records ORDER BY tbl/i.test(sql)) {
      // ORDER BY tbl is load-bearing: readAll closes one array and opens the
      // next when the table name changes, so unsorted rows would produce
      // duplicate keys. Sorting here keeps the fake honest about that.
      const sorted = [...rows.values()].sort((a, b) => (a.tbl < b.tbl ? -1 : a.tbl > b.tbl ? 1 : 0));
      return { results: sorted.map((r) => ({ tbl: r.tbl, data: r.data })) };
    }

    throw new Error(`fakeD1 does not know this statement: ${sql}`);
  };

  const prepare = (sql: string) => ({
    bind: (...args: unknown[]) => ({ all: async () => run(sql, args), run: async () => run(sql, args) }),
    all: async () => run(sql, []),
    run: async () => run(sql, []),
  });

  return {
    rows,
    prepare,
    batch: async (statements: { all: () => Promise<unknown> }[]) => {
      for (const s of statements) await s.all();
      return [];
    },
  };
}

type Db = ReturnType<typeof fakeD1>;
let db: Db;

beforeEach(async () => {
  db = fakeD1();
  await ensureSchema(db as never);
});

const rec = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, userId: 'local', amount: 12345, ...extra });

describe('readAll builds valid JSON by concatenation', () => {
  it('returns an empty object when there is nothing', async () => {
    const body = await readAll(db as never);
    expect(body).toBe('{}');
    expect(JSON.parse(body)).toEqual({});
  });

  it('handles a single record in a single table', async () => {
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: rec('e1') }]);
    const parsed = JSON.parse(await readAll(db as never));
    expect(parsed.expenses).toHaveLength(1);
    expect(parsed.expenses[0].id).toBe('e1');
  });

  it('comma-separates several records in one table', async () => {
    await applyWrites(db as never, [
      { tbl: 'expenses', id: 'e1', data: rec('e1') },
      { tbl: 'expenses', id: 'e2', data: rec('e2') },
      { tbl: 'expenses', id: 'e3', data: rec('e3') },
    ]);
    const parsed = JSON.parse(await readAll(db as never));
    expect(parsed.expenses.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });

  it('closes one table and opens the next', async () => {
    // The boundary case the concatenation gets wrong if the bracket or the
    // comma between groups is misplaced.
    await applyWrites(db as never, [
      { tbl: 'expenses', id: 'e1', data: rec('e1') },
      { tbl: 'loans', id: 'l1', data: rec('l1') },
      { tbl: 'bills', id: 'b1', data: rec('b1') },
      { tbl: 'bills', id: 'b2', data: rec('b2') },
    ]);
    const parsed = JSON.parse(await readAll(db as never));
    expect(Object.keys(parsed).sort()).toEqual(['bills', 'expenses', 'loans']);
    expect(parsed.bills).toHaveLength(2);
    expect(parsed.expenses).toHaveLength(1);
    expect(parsed.loans).toHaveLength(1);
  });

  it('survives a record containing braces, quotes and commas', async () => {
    // A payee like `SWIGGY {BLR}, "ORDER"` is JSON-escaped inside `data`, and
    // concatenation must not care. If it ever did, the failure would be a
    // corrupt response rather than a wrong field.
    const nasty = JSON.stringify({
      id: 'e1',
      description: 'SWIGGY {BLR}, "ORDER" [#4], 50% off',
      note: 'line\nbreak\tand \\ backslash',
    });
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: nasty }]);
    const parsed = JSON.parse(await readAll(db as never));
    expect(parsed.expenses[0].description).toBe('SWIGGY {BLR}, "ORDER" [#4], 50% off');
    expect(parsed.expenses[0].note).toBe('line\nbreak\tand \\ backslash');
  });

  it('returns records byte-identical to what was written', async () => {
    // The whole point of storing opaque text: nothing re-serialises it, so
    // key order and number formatting come back exactly as sent.
    const original = '{"id":"e1","amount":100000,"zzz":1,"aaa":2}';
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: original }]);
    expect(await readAll(db as never)).toBe(`{"expenses":[${original}]}`);
  });

  it('scales to a few hundred records without producing invalid JSON', async () => {
    const ops = Array.from({ length: 150 }, (_, i) => ({
      tbl: i % 2 === 0 ? 'expenses' : 'bills',
      id: `r${i}`,
      data: rec(`r${i}`),
    }));
    await applyWrites(db as never, ops);
    const parsed = JSON.parse(await readAll(db as never));
    expect(parsed.expenses).toHaveLength(75);
    expect(parsed.bills).toHaveLength(75);
  });
});

describe('applyWrites', () => {
  it('upserts rather than duplicating on a second write of the same id', async () => {
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: rec('e1', { amount: 1 }) }]);
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: rec('e1', { amount: 2 }) }]);
    const parsed = JSON.parse(await readAll(db as never));
    expect(parsed.expenses).toHaveLength(1);
    expect(parsed.expenses[0].amount).toBe(2);
  });

  it('deletes outright, leaving no tombstone', async () => {
    // One writer means a delete can be a delete. The old sync engine needed
    // soft deletes so a deletion could beat a stale offline edit; there is no
    // stale edit here to beat.
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: rec('e1') }]);
    await applyWrites(db as never, [{ tbl: 'expenses', id: 'e1' }]);
    expect(JSON.parse(await readAll(db as never))).toEqual({});
  });

  it('counts writes and deletes separately', async () => {
    const result = await applyWrites(db as never, [
      { tbl: 'expenses', id: 'e1', data: rec('e1') },
      { tbl: 'expenses', id: 'e2', data: rec('e2') },
      { tbl: 'expenses', id: 'gone' },
    ]);
    expect(result).toEqual({ written: 2, deleted: 1 });
  });

  it('refuses an unknown table', async () => {
    // The allowlist is the only validation this Worker does on a write, since
    // the record body is opaque to it.
    await expect(
      applyWrites(db as never, [{ tbl: 'sqlite_master', id: 'x', data: '{}' }]),
    ).rejects.toThrow(/Unknown table/);
  });

  it('refuses an empty or absurd id', async () => {
    await expect(applyWrites(db as never, [{ tbl: 'expenses', id: '', data: '{}' }])).rejects.toThrow();
    await expect(
      applyWrites(db as never, [{ tbl: 'expenses', id: 'x'.repeat(201), data: '{}' }]),
    ).rejects.toThrow();
  });

  it('refuses data that is not a string', async () => {
    await expect(
      applyWrites(db as never, [{ tbl: 'expenses', id: 'e1', data: { not: 'text' } as never }]),
    ).rejects.toThrow(/JSON text/);
  });

  it('rejects the whole batch when one op is bad', async () => {
    // applyWrites builds every statement before issuing any of them, so a bad
    // op throws before the batch runs — no half-applied import.
    await expect(
      applyWrites(db as never, [
        { tbl: 'expenses', id: 'e1', data: rec('e1') },
        { tbl: 'nope', id: 'e2', data: rec('e2') },
      ]),
    ).rejects.toThrow();
    expect(db.rows.size).toBe(0);
  });

  it('accepts an empty batch without touching the database', async () => {
    expect(await applyWrites(db as never, [])).toEqual({ written: 0, deleted: 0 });
  });
});

describe('counts and wipe', () => {
  it('reports a count per table', async () => {
    await applyWrites(db as never, [
      { tbl: 'expenses', id: 'e1', data: rec('e1') },
      { tbl: 'expenses', id: 'e2', data: rec('e2') },
      { tbl: 'loans', id: 'l1', data: rec('l1') },
    ]);
    expect(await counts(db as never)).toEqual({ expenses: 2, loans: 1 });
  });

  it('wipe returns how many it destroyed', async () => {
    await applyWrites(db as never, [
      { tbl: 'expenses', id: 'e1', data: rec('e1') },
      { tbl: 'loans', id: 'l1', data: rec('l1') },
    ]);
    expect(await wipe(db as never)).toBe(2);
    expect(JSON.parse(await readAll(db as never))).toEqual({});
  });
});

describe('MAX_OPS', () => {
  it('is small enough that parsing a full batch stays inside the CPU budget', () => {
    // Not a behavioural test — a tripwire. The free plan allows 10ms of CPU and
    // JSON.parse of the request body is the one unavoidable cost that scales
    // with the payload. Raising this is a decision, not a tweak.
    expect(MAX_OPS).toBeLessThanOrEqual(500);
  });
});
