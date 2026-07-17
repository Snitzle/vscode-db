import * as vscode from 'vscode';
import { DatabaseClient } from '../db/client';
import { DbClientManager } from '../db/clientManager';
import { promptAndExportQueryResult } from '../export/exportService';
import { parseSingleTableSelect } from '../sql/selectSource';
import { splitSqlStatements } from '../sql/statements';
import { ConnectionStore } from '../state/connectionStore';
import { QueryHistoryStore } from '../state/queryHistoryStore';
import { ConnectionMeta, RawQueryResult } from '../types';
import { QueryEditableInfo, QueryPanelEvent, QueryPanelRequest } from './protocol';
import { TablePanelManager } from './tablePanelManager';
import { renderWebviewHtml, toUserError } from './utils';

/**
 * Editor-tab SQL consoles, each bound to one connection. Several panels may
 * target the same connection; each "New query" opens a fresh tab. Bound .sql
 * editors get results-only panels instead (one per connection + document).
 */
export class QueryPanelManager implements vscode.Disposable {
  private readonly panels = new Set<QueryPanelInstance>();
  /** Results-only panels for .sql documents, keyed by connection + source. */
  private readonly documentPanels = new Map<string, QueryPanelInstance>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    private readonly tablePanels: TablePanelManager,
    private readonly queryHistory: QueryHistoryStore,
  ) {}

  async openQueryPanel(connectionId: string): Promise<void> {
    const connection = await this.requireConnection(connectionId);

    const panel = new QueryPanelInstance(
      this.context,
      this.connectionStore,
      this.clientManager,
      this.tablePanels,
      this.queryHistory,
      connection,
      { mode: 'console' },
      () => this.panels.delete(panel),
    );
    this.panels.add(panel);
  }

  /**
   * Run SQL from outside the webview (a bound .sql editor) and show the
   * results in a reusable results-only panel for that connection + source.
   */
  async runSqlOnConnection(connectionId: string, sql: string, sourceLabel: string): Promise<void> {
    const connection = await this.requireConnection(connectionId);
    const key = `${connectionId}::${sourceLabel}`;

    let panel = this.documentPanels.get(key);
    if (!panel) {
      const created = new QueryPanelInstance(
        this.context,
        this.connectionStore,
        this.clientManager,
        this.tablePanels,
        this.queryHistory,
        connection,
        { mode: 'results', sourceLabel },
        () => this.documentPanels.delete(key),
      );
      this.documentPanels.set(key, created);
      panel = created;
    }

    await panel.runExternalSql(sql);
  }

  /** Dev-only: re-render all open panels so rebuilt bundles are picked up. */
  reloadWebviews(): void {
    for (const panel of this.allPanels()) {
      panel.reloadWebview();
    }
  }

  closeConnectionPanels(connectionId: string): void {
    for (const panel of this.allPanels()) {
      if (panel.connectionId === connectionId) {
        panel.dispose();
      }
    }
  }

  dispose(): void {
    for (const panel of this.allPanels()) {
      panel.dispose();
    }
    this.panels.clear();
    this.documentPanels.clear();
  }

  private allPanels(): QueryPanelInstance[] {
    return [...this.panels, ...this.documentPanels.values()];
  }

  private async requireConnection(connectionId: string): Promise<ConnectionMeta> {
    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      throw new Error('Connection not found.');
    }
    return connection;
  }
}

interface QueryPanelOptions {
  mode: 'console' | 'results';
  /** Shown in the tab title of results-only panels (e.g. the .sql filename). */
  sourceLabel?: string;
}

class QueryPanelInstance implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private webviewReady = false;
  /** SQL waiting for the webview's 'ready' before results can be posted. */
  private pendingExternalSql: string | undefined;
  /** Last run's results, retained so export never re-executes the query. */
  private lastResults: RawQueryResult[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    private readonly tablePanels: TablePanelManager,
    private readonly queryHistory: QueryHistoryStore,
    private readonly connection: ConnectionMeta,
    private readonly options: QueryPanelOptions,
    private readonly onDispose: () => void,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'dbExplorer.queryPanel',
      this.buildTitle(),
      {
        preserveFocus: options.mode === 'results',
        viewColumn: options.mode === 'results' ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      },
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'database.svg');
    this.panel.webview.html = this.buildHtml();

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (message: QueryPanelRequest) => {
        await this.handleMessage(message);
      }),
      this.panel.onDidDispose(() => {
        this.disposed = true;
        vscode.Disposable.from(...this.disposables).dispose();
        this.onDispose();
      }),
    );
  }

  get connectionId(): string {
    return this.connection.id;
  }

  /** Run SQL pushed from a bound .sql editor into this results panel. */
  async runExternalSql(sql: string): Promise<void> {
    this.panel.reveal(undefined, true);

    if (!this.webviewReady) {
      // The 'ready' handler will pick this up once the webview boots.
      this.pendingExternalSql = sql;
      return;
    }

    try {
      await this.executeAndPost(sql);
    } catch (error) {
      const { message: text, details } = toUserError(error);
      this.postEvent({ kind: 'error', message: text, details });
    }
  }

  reloadWebview(): void {
    if (!this.disposed) {
      this.webviewReady = false;
      this.panel.webview.html = this.buildHtml();
    }
  }

  dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  private buildTitle(): string {
    return this.options.mode === 'results'
      ? `Results: ${this.connection.name} · ${this.options.sourceLabel ?? 'SQL'}`
      : `Query: ${this.connection.name}`;
  }

  private buildHtml(): string {
    return renderWebviewHtml(this.context, this.panel.webview, {
      scriptFile: 'dist/queryPanel.js',
      styleFiles: ['media/main.css', 'dist/queryPanel.css'],
      title: this.buildTitle(),
      surface: 'panel',
    });
  }

  private async handleMessage(message: QueryPanelRequest): Promise<void> {
    try {
      switch (message.kind) {
        case 'ready': {
          const client = await this.clientManager.getClient(this.connection.id);
          this.postEvent(
            {
              kind: 'queryConfig',
              connectionName: this.connection.name,
              dialect: client.dialect,
              environment: this.connection.environment,
              hideEditor: this.options.mode === 'results' ? true : undefined,
            },
            message.requestId,
          );

          this.webviewReady = true;
          if (this.pendingExternalSql !== undefined) {
            const sql = this.pendingExternalSql;
            this.pendingExternalSql = undefined;
            await this.executeAndPost(sql);
          }
          return;
        }

        case 'runQuery':
          await this.executeAndPost(message.sql, message.requestId);
          return;

        case 'updateQueryRows': {
          if (this.connection.environment === 'prod') {
            const count = message.payload.updates.length;
            const choice = await vscode.window.showWarningMessage(
              `PRODUCTION: apply ${count} row update${count === 1 ? '' : 's'} to ${message.payload.schema}.${message.payload.table} on "${this.connection.name}"?`,
              { modal: true },
              'Apply to production',
            );
            if (choice !== 'Apply to production') {
              return;
            }
          }

          const client = await this.clientManager.getClient(this.connection.id);
          await client.updateRows(message.payload);
          this.postEvent({ kind: 'mutationApplied', message: 'Changes applied.' }, message.requestId);

          // Grids showing the same table should pick the edits up.
          await this.tablePanels.refreshConnection(this.connection.id);
          return;
        }

        case 'pickQueryHistory':
          await this.pickQueryHistory(message.requestId);
          return;

        case 'exportResults': {
          const result = this.lastResults[message.statementIndex];
          if (!result) {
            throw new Error('That result set is no longer available — re-run the query.');
          }

          const client = await this.clientManager.getClient(this.connection.id);
          const outcome = await promptAndExportQueryResult(client.dialect, result);
          if (outcome) {
            this.postEvent({ kind: 'info', message: outcome }, message.requestId);
          }
          return;
        }

        default:
          this.assertNever(message);
      }
    } catch (error) {
      const { message: text, details } = toUserError(error);
      this.postEvent({ kind: 'error', message: text, details }, message.requestId);
    }
  }

  /** Execute a script, record it in history, and post results to the webview. */
  private async executeAndPost(sql: string, requestId?: string): Promise<void> {
    const client = await this.clientManager.getClient(this.connection.id);
    const startedAt = Date.now();

    let results: RawQueryResult[];
    try {
      results = await client.executeRaw(sql);
    } catch (error) {
      await this.recordHistory(sql, Date.now() - startedAt, toUserError(error).message);
      throw error;
    }
    await this.recordHistory(sql, Date.now() - startedAt);

    this.lastResults = results;
    const editable = await this.detectEditableResults(client, sql, results);
    this.postEvent({ kind: 'queryResults', results, editable }, requestId);

    // DML/DDL may have changed data that open grids are showing.
    if (results.some((result) => result.affectedRows !== undefined)) {
      await this.tablePanels.refreshConnection(this.connection.id);
    }
  }

  private async recordHistory(sql: string, durationMs: number, error?: string): Promise<void> {
    try {
      await this.queryHistory.record({
        connectionId: this.connection.id,
        connectionName: this.connection.name,
        sql,
        runAt: new Date().toISOString(),
        durationMs,
        ok: error === undefined,
        error,
      });
    } catch {
      // History is best-effort; never let it break a query run.
    }
  }

  /**
   * Native QuickPick over the shared history (fuzzy full-text via
   * matchOnDetail); the chosen statement is inserted into the SQL editor.
   */
  private async pickQueryHistory(requestId?: string): Promise<void> {
    const entries = await this.queryHistory.list();
    if (entries.length === 0) {
      this.postEvent({ kind: 'info', message: 'No query history yet.' }, requestId);
      return;
    }

    // This connection's entries first; other connections stay reachable below.
    const ordered = [
      ...entries.filter((entry) => entry.connectionId === this.connection.id),
      ...entries.filter((entry) => entry.connectionId !== this.connection.id),
    ];

    const picked = await vscode.window.showQuickPick(
      ordered.map((entry) => ({
        label: entry.sql.split('\n')[0].slice(0, 80),
        description: `${entry.connectionName} · ${formatRunAt(entry.runAt)}${entry.ok ? '' : ' · failed'}`,
        detail: entry.sql.length > 200 ? `${entry.sql.slice(0, 200)}…` : entry.sql,
        sql: entry.sql,
      })),
      {
        title: 'Query history',
        placeHolder: 'Search past queries (matches full SQL text)',
        matchOnDetail: true,
        matchOnDescription: true,
      },
    );

    if (picked) {
      this.postEvent({ kind: 'insertSql', sql: picked.sql }, requestId);
    }
  }

  /**
   * Work out, per result set, whether its rows can be edited in place: the
   * statement must be a simple single-table SELECT, the table writable, every
   * key column present in the result, and the column names unambiguous.
   */
  private async detectEditableResults(
    client: DatabaseClient,
    sql: string,
    results: RawQueryResult[],
  ): Promise<(QueryEditableInfo | null)[]> {
    const statements = splitSqlStatements(sql);
    const defaultSchema = this.connection.type === 'mysql' ? this.connection.database : 'main';

    return Promise.all(
      results.map(async (result): Promise<QueryEditableInfo | null> => {
        if (result.columns.length === 0) {
          return null;
        }
        // Repeated column names (e.g. two count(*)) cannot be mapped back.
        if (new Set(result.columns).size !== result.columns.length) {
          return null;
        }

        const statement = statements[result.statementIndex];
        const source = statement ? parseSingleTableSelect(statement) : undefined;
        if (!source) {
          return null;
        }

        try {
          const info = await client.getTableInfo(source.schema ?? defaultSchema, source.table, 'table');
          if (info.readOnly || info.writableKey.kind === 'none') {
            return null;
          }
          // Updates need the full key in the result to address rows.
          if (!info.writableKey.columns.every((key) => result.columns.includes(key))) {
            return null;
          }

          return {
            schema: info.schema,
            table: info.name,
            keyKind: info.writableKey.kind,
            keyColumns: info.writableKey.columns,
            columns: result.columns.map((name) => {
              const column = info.columns.find((item) => item.name === name);
              if (!column) {
                // Expression or alias — displayable but not writable.
                return { name, editable: false };
              }
              return {
                name,
                editable: !column.isAutoIncrement && !info.writableKey.columns.includes(name),
                nullable: column.nullable,
                dataType: column.dataType,
              };
            }),
          };
        } catch {
          // Table lookup failed (view, dropped table, permissions): read-only.
          return null;
        }
      }),
    );
  }

  private postEvent(event: QueryPanelEvent, requestId?: string): void {
    if (this.disposed) {
      return;
    }

    void this.panel.webview.postMessage({
      ...event,
      requestId,
    });
  }

  private assertNever(_message: never): never {
    throw new Error('Unhandled query panel request.');
  }
}

function formatRunAt(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) {
    return iso;
  }

  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}
