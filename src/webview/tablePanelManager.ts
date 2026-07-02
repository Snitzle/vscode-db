import * as vscode from 'vscode';
import { DbClientManager } from '../db/clientManager';
import { promptAndExportTable } from '../export/exportService';
import { ConnectionStore } from '../state/connectionStore';
import { Scalar, TableQuery } from '../types';
import { TablePanelEvent, TablePanelRequest } from './protocol';
import { openTextInEditor, renderWebviewHtml, toUserError } from './utils';

interface TablePanelTarget {
  connectionId: string;
  schema: string;
  objectName: string;
  objectType: 'table' | 'view';
  pageSize: number;
}

interface ActiveTableState {
  connectionId: string;
  schema: string;
  table: string;
  objectType: 'table' | 'view';
  page: number;
  pageSize: number;
  sort?: TableQuery['sort'];
  filters?: TableQuery['filters'];
  where?: TableQuery['where'];
}

export class TablePanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, TablePanelInstance>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
  ) {}

  async openTable(target: TablePanelTarget): Promise<void> {
    const key = this.toPanelKey(target);
    const existing = this.panels.get(key);

    if (existing) {
      existing.reveal();
      await existing.refresh();
      return;
    }

    const panel = new TablePanelInstance(
      this.context,
      this.connectionStore,
      this.clientManager,
      target,
      () => {
        this.panels.delete(key);
      },
    );

    this.panels.set(key, panel);
  }

  async refreshAll(): Promise<void> {
    const refreshes = [...this.panels.values()].map((panel) => panel.refresh());
    await Promise.allSettled(refreshes);
  }

  /** Dev-only: re-render all open panels so rebuilt bundles are picked up. */
  reloadWebviews(): void {
    for (const panel of this.panels.values()) {
      panel.reloadWebview();
    }
  }

  async refreshConnection(connectionId: string): Promise<void> {
    const refreshes = [...this.panels.values()]
      .filter((panel) => panel.connectionId === connectionId)
      .map((panel) => panel.refresh());

    await Promise.allSettled(refreshes);
  }

  closeConnectionPanels(connectionId: string): void {
    for (const panel of [...this.panels.values()]) {
      if (panel.connectionId === connectionId) {
        panel.dispose();
      }
    }
  }

  dispose(): void {
    for (const panel of [...this.panels.values()]) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private toPanelKey(target: TablePanelTarget): string {
    return JSON.stringify([target.connectionId, target.schema, target.objectType, target.objectName]);
  }
}

class TablePanelInstance implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private activeTable: ActiveTableState;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    target: TablePanelTarget,
    private readonly onDispose: () => void,
  ) {
    this.activeTable = {
      connectionId: target.connectionId,
      schema: target.schema,
      table: target.objectName,
      objectType: target.objectType,
      page: 0,
      pageSize: Math.max(1, Math.min(500, target.pageSize)),
    };

    this.panel = vscode.window.createWebviewPanel(
      'dbExplorer.tablePanel',
      this.buildTitle(),
      {
        preserveFocus: false,
        viewColumn: vscode.ViewColumn.Active,
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
      this.panel.webview.onDidReceiveMessage(async (message: TablePanelRequest) => {
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
    return this.activeTable.connectionId;
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  async refresh(): Promise<void> {
    if (this.disposed) {
      return;
    }

    await this.refreshActiveTable();
    await this.updateTitle();
  }

  dispose(): void {
    if (!this.disposed) {
      this.panel.dispose();
    }
  }

  /** Dev-only: reload the webview HTML; the 'ready' round-trip repopulates it. */
  reloadWebview(): void {
    if (!this.disposed) {
      this.panel.webview.html = this.buildHtml();
    }
  }

  private buildHtml(): string {
    return renderWebviewHtml(this.context, this.panel.webview, {
      scriptFile: 'dist/tablePanel.js',
      styleFiles: ['media/main.css', 'dist/tablePanel.css'],
      title: this.buildTitle(),
      surface: 'panel',
    });
  }

  private async handleMessage(message: TablePanelRequest): Promise<void> {
    try {
      switch (message.kind) {
        case 'ready':
        case 'refreshTable':
          await this.refresh();
          return;

        case 'queryTableRows':
          this.activeTable = {
            ...this.activeTable,
            page: Math.max(0, message.page),
            pageSize: Math.max(1, Math.min(500, message.pageSize)),
            sort: message.sort,
            filters: message.filters,
            where: message.where,
          };
          await this.refreshActiveTable(message.requestId);
          return;

        case 'insertRow': {
          const client = await this.clientManager.getClient(this.activeTable.connectionId);
          await client.insertRow(message.payload);
          this.postEvent({ kind: 'mutationApplied', message: 'Row inserted.' }, message.requestId);
          await this.refreshActiveTable(message.requestId);
          return;
        }

        case 'duplicateRow':
          await this.duplicateRow(message.row.values, message.requestId);
          return;

        case 'updateRows': {
          const client = await this.clientManager.getClient(this.activeTable.connectionId);
          await client.updateRows(message.payload);
          this.postEvent({ kind: 'mutationApplied', message: 'Changes applied.' }, message.requestId);
          await this.refreshActiveTable(message.requestId);
          return;
        }

        case 'deleteRows': {
          const count = message.payload.keys.length;
          const choice = await vscode.window.showWarningMessage(
            `Delete ${count} row${count === 1 ? '' : 's'} from ${this.activeTable.schema}.${this.activeTable.table}? This cannot be undone.`,
            { modal: true },
            'Delete',
          );
          if (choice !== 'Delete') {
            return;
          }

          const client = await this.clientManager.getClient(this.activeTable.connectionId);
          await client.deleteRows(message.payload);
          this.postEvent({ kind: 'mutationApplied', message: 'Rows deleted.' }, message.requestId);
          await this.refreshActiveTable(message.requestId);
          return;
        }

        case 'viewDdl':
          await this.viewDdl(message.requestId);
          return;

        case 'openDdlInEditor':
          await openTextInEditor('sql', message.ddl);
          this.postEvent({ kind: 'info', message: 'DDL opened in editor.' }, message.requestId);
          return;

        case 'exportTable': {
          const client = await this.clientManager.getClient(this.activeTable.connectionId);
          const outcome = await promptAndExportTable(client, this.activeTable, message.selection);
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

  private async duplicateRow(sourceValues: Record<string, Scalar>, requestId?: string): Promise<void> {
    const client = await this.clientManager.getClient(this.activeTable.connectionId);
    const tableInfo = await client.getTableInfo(
      this.activeTable.schema,
      this.activeTable.table,
      this.activeTable.objectType,
    );

    const insertValues: Record<string, Scalar> = {};

    for (const column of tableInfo.columns) {
      if (column.isPrimaryKey || column.isAutoIncrement) {
        continue;
      }
      insertValues[column.name] = sourceValues[column.name] ?? null;
    }

    await client.insertRow({
      schema: this.activeTable.schema,
      table: this.activeTable.table,
      values: insertValues,
    });

    this.postEvent({ kind: 'mutationApplied', message: 'Row duplicated.' }, requestId);
    await this.refreshActiveTable(requestId);
  }

  private async viewDdl(requestId?: string): Promise<void> {
    const client = await this.clientManager.getClient(this.activeTable.connectionId);
    const ddl = await client.getDdl(this.activeTable.schema, this.activeTable.table, this.activeTable.objectType);

    this.postEvent(
      {
        kind: 'ddl',
        connectionId: this.activeTable.connectionId,
        schema: this.activeTable.schema,
        objectName: this.activeTable.table,
        objectType: this.activeTable.objectType,
        ddl,
      },
      requestId,
    );
  }

  private async refreshActiveTable(requestId?: string): Promise<void> {
    const client = await this.clientManager.getClient(this.activeTable.connectionId);
    const result = await client.queryTableRows(
      {
        schema: this.activeTable.schema,
        table: this.activeTable.table,
        page: this.activeTable.page,
        pageSize: this.activeTable.pageSize,
        sort: this.activeTable.sort,
        filters: this.activeTable.filters,
        where: this.activeTable.where,
        includeCount: true,
      },
      this.activeTable.objectType,
    );

    this.activeTable = {
      ...this.activeTable,
      schema: result.info.schema,
      table: result.info.name,
      objectType: result.info.objectType,
      page: result.page,
      pageSize: result.pageSize,
    };

    this.postEvent(
      {
        kind: 'tableData',
        connectionId: this.activeTable.connectionId,
        info: result.info,
        rows: result.rows,
        page: result.page,
        pageSize: result.pageSize,
        totalCount: result.totalCount,
        sort: this.activeTable.sort,
        filters: this.activeTable.filters,
        where: this.activeTable.where,
      },
      requestId,
    );
  }

  private postEvent(event: TablePanelEvent, requestId?: string): void {
    if (this.disposed) {
      return;
    }

    void this.panel.webview.postMessage({
      ...event,
      requestId,
    });
  }

  private async updateTitle(): Promise<void> {
    const connection = await this.connectionStore.getConnection(this.activeTable.connectionId);
    this.panel.title = connection
      ? `${connection.name}: ${this.activeTable.schema}.${this.activeTable.table}`
      : this.buildTitle();
  }

  private buildTitle(): string {
    return `${this.activeTable.schema}.${this.activeTable.table}`;
  }

  private assertNever(_message: never): never {
    throw new Error('Unhandled table panel request.');
  }
}
