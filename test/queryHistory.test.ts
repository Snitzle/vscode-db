import { strict as assert } from 'assert';
import { pushHistoryEntry, QueryHistoryEntry } from '../src/state/queryHistoryStore';

function entry(overrides: Partial<QueryHistoryEntry>): QueryHistoryEntry {
  return {
    connectionId: 'c1',
    connectionName: 'Local',
    sql: 'select 1',
    runAt: '2026-07-16T10:00:00.000Z',
    ok: true,
    ...overrides,
  };
}

describe('pushHistoryEntry', () => {
  it('prepends the newest entry', () => {
    const next = pushHistoryEntry([entry({ sql: 'select 1' })], entry({ sql: 'select 2' }), 10);
    assert.deepEqual(
      next.map((item) => item.sql),
      ['select 2', 'select 1'],
    );
  });

  it('dedupes a re-run of the same sql on the same connection', () => {
    const existing = [entry({ sql: 'select 1' }), entry({ sql: 'select 2' })];
    const next = pushHistoryEntry(existing, entry({ sql: 'select 2', runAt: '2026-07-16T11:00:00.000Z' }), 10);
    assert.deepEqual(
      next.map((item) => item.sql),
      ['select 2', 'select 1'],
    );
    assert.equal(next[0].runAt, '2026-07-16T11:00:00.000Z');
  });

  it('keeps the same sql on different connections as separate entries', () => {
    const existing = [entry({ sql: 'select 1', connectionId: 'c1' })];
    const next = pushHistoryEntry(existing, entry({ sql: 'select 1', connectionId: 'c2' }), 10);
    assert.equal(next.length, 2);
  });

  it('caps the list length, dropping the oldest', () => {
    const existing = [entry({ sql: 'a' }), entry({ sql: 'b' }), entry({ sql: 'c' })];
    const next = pushHistoryEntry(existing, entry({ sql: 'd' }), 3);
    assert.deepEqual(
      next.map((item) => item.sql),
      ['d', 'a', 'b'],
    );
  });
});
