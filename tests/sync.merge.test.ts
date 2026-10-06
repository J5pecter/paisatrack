import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  commitMessage,
  mergePayloads,
  mergeTable,
  parsePayload,
  pickWinner,
  serialisePayload,
} from '@/lib/sync/merge';
import type { BaseRecord, SyncTable } from '@/types';

function rec(id: string, updatedAt: string, extra: Record<string, unknown> = {}): BaseRecord {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
    deviceId: 'dev_a',
    deletedAt: null,
    ...extra,
  } as BaseRecord;
}

describe('pickWinner', () => {
  it('takes the later write', () => {
    expect(pickWinner(rec('x', '2026-02-01T00:00:00.000Z'), rec('x', '2026-01-01T00:00:00.000Z')))
      .toBe('LOCAL');
    expect(pickWinner(rec('x', '2026-01-01T00:00:00.000Z'), rec('x', '2026-02-01T00:00:00.000Z')))
      .toBe('REMOTE');
  });

  it('lets a tombstone beat a live record on an exact tie', () => {
    const t = '2026-02-01T00:00:00.000Z';
    const live = rec('x', t, { deviceId: 'dev_a' });
    const deleted = rec('x', t, { deviceId: 'dev_b', deletedAt: t });
    expect(pickWinner(live, deleted)).toBe('REMOTE');
    expect(pickWinner(deleted, live)).toBe('LOCAL');
  });

  it('breaks remaining ties deterministically, so both devices agree', () => {
    const t = '2026-02-01T00:00:00.000Z';
    const a = rec('x', t, { deviceId: 'dev_a' });
    const b = rec('x', t, { deviceId: 'dev_b' });

    // From device A's point of view, and from device B's, the SAME record wins.
    expect(pickWinner(a, b)).toBe('REMOTE'); // b > a lexicographically
    expect(pickWinner(b, a)).toBe('LOCAL');  // again b
  });
});

describe('mergeTable', () => {
  const T: SyncTable = 'expenses';

  it('keeps records only one side has', () => {
    const r = mergeTable(T, [rec('a', '2026-01-01T00:00:00.000Z')], [rec('b', '2026-01-01T00:00:00.000Z')]);
    expect(r.merged.map((x) => x.id).sort()).toEqual(['a', 'b']);
    expect(r.toPush.map((x) => x.id)).toEqual(['a']);
    expect(r.toApplyLocally.map((x) => x.id)).toEqual(['b']);
  });

  it('resolves a genuine edit conflict and records it', () => {
    const local = rec('a', '2026-02-01T00:00:00.000Z', { amount: 100 });
    const remote = rec('a', '2026-01-01T00:00:00.000Z', { amount: 200 });
    const r = mergeTable(T, [local], [remote]);

    expect(r.merged).toHaveLength(1);
    expect((r.merged[0] as unknown as { amount: number }).amount).toBe(100);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].winner).toBe('LOCAL');
  });

  it('does not call an identical record a conflict', () => {
    const same = rec('a', '2026-01-01T00:00:00.000Z', { amount: 100 });
    const r = mergeTable(T, [same], [{ ...same }]);
    expect(r.conflicts).toHaveLength(0);
  });

  it('propagates a deletion instead of resurrecting the record', () => {
    const live = rec('a', '2026-01-01T00:00:00.000Z', { amount: 100 });
    const tombstone = rec('a', '2026-02-01T00:00:00.000Z', {
      amount: 100,
      deletedAt: '2026-02-01T00:00:00.000Z',
    });
    const r = mergeTable(T, [live], [tombstone]);
    expect(r.merged[0].deletedAt).toBeTruthy();
    expect(r.toApplyLocally).toHaveLength(1);
  });

  it('is symmetric: both devices converge on the same set', () => {
    const a = [rec('1', '2026-02-01T00:00:00.000Z', { v: 'a' }), rec('2', '2026-01-01T00:00:00.000Z')];
    const b = [rec('1', '2026-01-01T00:00:00.000Z', { v: 'b' }), rec('3', '2026-01-01T00:00:00.000Z')];

    const fromA = mergeTable(T, a, b).merged;
    const fromB = mergeTable(T, b, a).merged;

    const key = (rows: BaseRecord[]) =>
      rows.map((r) => `${r.id}@${r.updatedAt}`).sort().join('|');
    expect(key(fromA)).toBe(key(fromB));
  });

  it('handles both sides being empty', () => {
    const r = mergeTable(T, [], []);
    expect(r.merged).toEqual([]);
    expect(r.conflicts).toEqual([]);
  });
});

describe('payload round trip', () => {
  it('serialises and parses back to the same data', async () => {
    const data = {
      expenses: [rec('e1', '2026-01-01T00:00:00.000Z', { amount: 5000 })],
    } as unknown as Record<SyncTable, BaseRecord[]>;

    const text = serialisePayload(buildPayload(data, 'dev_a'));
    const parsed = await parsePayload(text);

    expect(parsed.data.expenses).toHaveLength(1);
    expect(parsed.data.expenses[0].id).toBe('e1');
    // Every table is present, even the empty ones.
    expect(parsed.data.loans).toEqual([]);
  });

  it('sorts records by id so git diffs stay readable', () => {
    const data = {
      expenses: [rec('e3', '2026-01-01T00:00:00.000Z'), rec('e1', '2026-01-01T00:00:00.000Z')],
    } as unknown as Record<SyncTable, BaseRecord[]>;
    const payload = buildPayload(data, 'dev_a');
    expect(payload.data.expenses.map((r) => (r as BaseRecord).id)).toEqual(['e1', 'e3']);
  });

  it('refuses malformed JSON rather than wiping local data', async () => {
    await expect(parsePayload('not json at all')).rejects.toThrow(/not valid JSON/);
    await expect(parsePayload('{"hello":1}')).rejects.toThrow(/does not look like/);
  });

  it('refuses a payload from a newer schema', async () => {
    const future = JSON.stringify({ schemaVersion: 99, data: {} });
    await expect(parsePayload(future)).rejects.toThrow(/newer version/);
  });

  it('tolerates a partial payload with missing tables', async () => {
    const partial = JSON.stringify({ schemaVersion: 1, data: { expenses: [] } });
    const parsed = await parsePayload(partial);
    expect(parsed.data.creditCards).toEqual([]);
  });
});

describe('mergePayloads', () => {
  it('merges every table and reports local changes', () => {
    const local = { expenses: [rec('a', '2026-02-01T00:00:00.000Z')] } as unknown as Record<SyncTable, BaseRecord[]>;
    const remote = { loans: [rec('b', '2026-01-01T00:00:00.000Z')] } as unknown as Record<SyncTable, BaseRecord[]>;

    const r = mergePayloads(local, remote);
    expect(r.merged.expenses).toHaveLength(1);
    expect(r.merged.loans).toHaveLength(1);
    expect(r.toApplyLocally.loans).toHaveLength(1);
    expect(r.hasLocalChanges).toBe(true);
  });
});

describe('commit messages', () => {
  it('summarises what changed', () => {
    expect(commitMessage({ expenses: 3, loans: 1 }, 'dev_a'))
      .toBe('sync: 3 expenses, 1 loans [dev_a]');
  });

  it('handles nothing changing', () => {
    expect(commitMessage({}, 'dev_a')).toBe('sync: no changes [dev_a]');
  });
});
