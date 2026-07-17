import * as vscode from 'vscode';

const HISTORY_STATE_KEY = 'dbExplorer.queryHistory';
const HISTORY_LIMIT = 200;

export interface QueryHistoryEntry {
  connectionId: string;
  connectionName: string;
  sql: string;
  /** ISO timestamp of the run. */
  runAt: string;
  durationMs?: number;
  ok: boolean;
  error?: string;
}

/**
 * Rolling log of executed SQL (query panels and bound .sql editors), newest
 * first. Kept local — history routinely contains data-revealing literals, so
 * it is deliberately not registered for Settings Sync.
 */
export class QueryHistoryStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async list(): Promise<QueryHistoryEntry[]> {
    const existing = this.context.globalState.get<QueryHistoryEntry[]>(HISTORY_STATE_KEY);
    return Array.isArray(existing) ? existing : [];
  }

  async record(entry: QueryHistoryEntry): Promise<void> {
    const next = pushHistoryEntry(await this.list(), entry, HISTORY_LIMIT);
    await this.context.globalState.update(HISTORY_STATE_KEY, next);
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(HISTORY_STATE_KEY, []);
  }
}

/**
 * Prepend `entry`, deduplicating an identical statement re-run against the
 * same connection (the old occurrence is dropped so the list stays a set of
 * distinct statements ordered by most recent run), and cap the length.
 * Pure, so it is unit-tested directly.
 */
export function pushHistoryEntry(
  existing: QueryHistoryEntry[],
  entry: QueryHistoryEntry,
  limit: number,
): QueryHistoryEntry[] {
  const withoutDuplicate = existing.filter(
    (item) => !(item.connectionId === entry.connectionId && item.sql === entry.sql),
  );
  return [entry, ...withoutDuplicate].slice(0, limit);
}
