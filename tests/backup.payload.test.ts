/**
 * The backup file format.
 *
 * These assertions moved here when the sync engine was deleted. The merging
 * they used to sit beside — last-write-wins, conflict detection, the deviceId
 * tiebreaker — is gone with it, because there is one authoritative copy now
 * and nothing left to reconcile.
 *
 * The format itself is not gone and matters more than it did. The server holds
 * the only copy of someone's finances; a file on their own disk is the only
 * thing that survives a deleted Cloudflare account or a lost token. These tests
 * are what stop a restore from silently dropping records.
 */
import { describe, expect, it } from 'vitest';
import { buildPayload, parsePayload, serialisePayload } from '@/lib/backup/payload';
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
