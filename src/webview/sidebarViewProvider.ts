import * as vscode from 'vscode';
import { ConnectionStore } from '../state/connectionStore';
import { DbClientManager } from '../db/clientManager';
import { ExtensionEvent, WebviewRequest } from './protocol';
import {
  ConnectionInput,
  ConnectionMeta,
  ConnectionTreeNode,
  DeleteRowsRequest,
  InsertRowRequest,
  Scalar,
  TableQuery,
  UpdateRowsRequest,
} from '../types';

interface ActiveTableState {
  connectionId: string;
  schema: string;
  table: string;
  objectType: 'table' | 'view';
  page: number;
  pageSize: number;
  sort?: TableQuery['sort'];
  filter?: TableQuery['filter'];
}

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dbExplorer.sidebar';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private activeTable: ActiveTableState | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    view.webview.html = this.getHtml(view.webview);

    const messageDisposable = view.webview.onDidReceiveMessage(async (message: WebviewRequest) => {
      await this.handleMessage(message);
    });

    const disposeDisposable = view.onDidDispose(() => {
      this.view = undefined;
    });

    this.disposables.push(messageDisposable, disposeDisposable);
  }

  async refresh(): Promise<void> {
    await this.postState();
    await this.refreshActiveTable();
  }

  requestAddConnection(): void {
    this.postEvent({ kind: 'triggerAddConnection' });
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleMessage(message: WebviewRequest): Promise<void> {
    try {
      switch (message.kind) {
        case 'ready':
        case 'refreshTree':
          await this.postState(message.requestId);
          return;

        case 'saveConnection':
          await this.saveConnection(message.connection, message.mode, message.requestId);
          return;

        case 'removeConnection':
          await this.removeConnection(message.connectionId, message.requestId);
          return;

        case 'pickSqliteFile': {
          const filePath = await this.pickSqliteFile();
          this.postEvent({ kind: 'sqliteFilePicked', filePath }, message.requestId);
          return;
        }

        case 'selectConnectionForEdit':
          await this.selectConnectionForEdit(message.connectionId, message.requestId);
          return;

        case 'openTable':
          this.activeTable = {
            connectionId: message.connectionId,
            schema: message.schema,
            table: message.objectName,
            objectType: message.objectType,
            page: 0,
            pageSize: Math.max(1, Math.min(500, message.pageSize)),
          };
          await this.refreshActiveTable(message.requestId);
          return;

        case 'queryTableRows':
          this.activeTable = {
            connectionId: message.connectionId,
            schema: message.schema,
            table: message.table,
            objectType: message.objectType,
            page: Math.max(0, message.page),
            pageSize: Math.max(1, Math.min(500, message.pageSize)),
            sort: message.sort,
            filter: message.filter,
          };
          await this.refreshActiveTable(message.requestId);
          return;

        case 'insertRow':
          await this.insertRow(message.connectionId, message.payload, message.requestId);
          return;

        case 'duplicateRow':
          await this.duplicateRow(
            message.connectionId,
            message.schema,
            message.table,
            message.row.values,
            message.requestId,
          );
          return;

        case 'updateRows':
          await this.updateRows(message.connectionId, message.payload, message.requestId);
          return;

        case 'deleteRows':
          await this.deleteRows(message.connectionId, message.payload, message.requestId);
          return;

        case 'viewDdl':
          await this.viewDdl(
            message.connectionId,
            message.schema,
            message.objectName,
            message.objectType,
            message.requestId,
          );
          return;

        case 'openDdlInEditor':
          await this.openDdlInEditor(message.title, message.ddl);
          this.postEvent({ kind: 'info', message: 'DDL opened in editor.' }, message.requestId);
          return;

        default:
          this.assertNever(message);
      }
    } catch (error) {
      const { message: text, details } = toUserError(error);
      this.postEvent({ kind: 'error', message: text, details }, message.requestId);
    }
  }

  private async postState(requestId?: string): Promise<void> {
    const [tree, connections] = await Promise.all([this.buildTree(), this.connectionStore.listConnections()]);
    this.postEvent({ kind: 'state', tree, connections }, requestId);
  }

  private async buildTree(): Promise<ConnectionTreeNode[]> {
    const connections = await this.connectionStore.listConnections();
    const results = await Promise.all(connections.map((connection) => this.buildConnectionNode(connection)));
    return results;
  }

  private async buildConnectionNode(connection: ConnectionMeta): Promise<ConnectionTreeNode> {
    try {
      const client = await this.clientManager.getClient(connection.id);
      const schemas = await client.listSchemas();

      const schemaNodes = [] as ConnectionTreeNode['schemas'];
      for (const schema of schemas) {
        const objects = await client.listObjects(schema);
        if (objects.length > 0) {
          schemaNodes.push({ name: schema, objects });
        }
      }

      return {
        connectionId: connection.id,
        connectionType: connection.type,
        name: connection.name,
        status: 'connected',
        schemas: schemaNodes,
      };
    } catch (error) {
      return {
        connectionId: connection.id,
        connectionType: connection.type,
        name: connection.name,
        status: 'error',
        message: toUserError(error).message,
        schemas: [],
      };
    }
  }

  private async saveConnection(
    input: ConnectionInput,
    mode: 'add' | 'edit',
    requestId?: string,
  ): Promise<void> {
    const normalized = normalizeConnectionInput(input, mode);
    const saved = await this.connectionStore.upsertConnection(normalized);
    await this.clientManager.invalidate(saved.id);

    this.postEvent(
      {
        kind: 'info',
        message: mode === 'add' ? `Connection "${saved.name}" added.` : `Connection "${saved.name}" updated.`,
      },
      requestId,
    );

    await this.postState(requestId);
  }

  private async removeConnection(connectionId: string, requestId?: string): Promise<void> {
    await this.connectionStore.removeConnection(connectionId);
    await this.clientManager.invalidate(connectionId);

    if (this.activeTable?.connectionId === connectionId) {
      this.activeTable = undefined;
    }

    this.postEvent({ kind: 'info', message: 'Connection removed.' }, requestId);
    await this.postState(requestId);
  }

  private async selectConnectionForEdit(connectionId: string, requestId?: string): Promise<void> {
    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      throw new Error('Connection not found.');
    }

    this.postEvent({ kind: 'connectionSelectedForEdit', connection }, requestId);
  }

  private async insertRow(
    connectionId: string,
    payload: InsertRowRequest,
    requestId?: string,
  ): Promise<void> {
    const client = await this.clientManager.getClient(connectionId);
    await client.insertRow(payload);
    this.postEvent({ kind: 'mutationApplied', message: 'Row inserted.' }, requestId);
    await this.refreshActiveTable(requestId);
  }

  private async duplicateRow(
    connectionId: string,
    schema: string,
    table: string,
    sourceValues: Record<string, Scalar>,
    requestId?: string,
  ): Promise<void> {
    const client = await this.clientManager.getClient(connectionId);
    const tableInfo = await client.getTableInfo(schema, table, 'table');

    const insertValues: Record<string, Scalar> = {};

    for (const column of tableInfo.columns) {
      if (column.isPrimaryKey || column.isAutoIncrement) {
        continue;
      }
      insertValues[column.name] = sourceValues[column.name] ?? null;
    }

    await client.insertRow({ schema, table, values: insertValues });
    this.postEvent({ kind: 'mutationApplied', message: 'Row duplicated.' }, requestId);
    await this.refreshActiveTable(requestId);
  }

  private async updateRows(
    connectionId: string,
    payload: UpdateRowsRequest,
    requestId?: string,
  ): Promise<void> {
    const client = await this.clientManager.getClient(connectionId);
    await client.updateRows(payload);
    this.postEvent({ kind: 'mutationApplied', message: 'Changes applied.' }, requestId);
    await this.refreshActiveTable(requestId);
  }

  private async deleteRows(
    connectionId: string,
    payload: DeleteRowsRequest,
    requestId?: string,
  ): Promise<void> {
    const client = await this.clientManager.getClient(connectionId);
    await client.deleteRows(payload);
    this.postEvent({ kind: 'mutationApplied', message: 'Rows deleted.' }, requestId);
    await this.refreshActiveTable(requestId);
  }

  private async viewDdl(
    connectionId: string,
    schema: string,
    objectName: string,
    objectType: 'table' | 'view',
    requestId?: string,
  ): Promise<void> {
    const client = await this.clientManager.getClient(connectionId);
    const ddl = await client.getDdl(schema, objectName, objectType);
    this.postEvent(
      {
        kind: 'ddl',
        connectionId,
        schema,
        objectName,
        objectType,
        ddl,
      },
      requestId,
    );
  }

  private async refreshActiveTable(requestId?: string): Promise<void> {
    if (!this.activeTable) {
      return;
    }

    const client = await this.clientManager.getClient(this.activeTable.connectionId);
    const result = await client.queryTableRows(
      {
        schema: this.activeTable.schema,
        table: this.activeTable.table,
        page: this.activeTable.page,
        pageSize: this.activeTable.pageSize,
        sort: this.activeTable.sort,
        filter: this.activeTable.filter,
        includeCount: true,
      },
      this.activeTable.objectType,
    );

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
        filter: this.activeTable.filter,
      },
      requestId,
    );
  }

  private async pickSqliteFile(): Promise<string | undefined> {
    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select SQLite Database',
      filters: {
        'SQLite Database': ['db', 'sqlite', 'sqlite3'],
        'All Files': ['*'],
      },
    });

    return selected?.[0]?.fsPath;
  }

  private async openDdlInEditor(_title: string, ddl: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: ddl,
    });

    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: vscode.ViewColumn.Active,
    });
  }

  private postEvent(event: ExtensionEvent, requestId?: string): void {
    if (!this.view) {
      return;
    }

    void this.view.webview.postMessage({
      ...event,
      requestId,
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.css'));
    const nonce = createNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>DB Explorer</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private assertNever(_message: never): never {
    throw new Error('Unhandled webview request.');
  }
}

function normalizeConnectionInput(input: ConnectionInput, mode: 'add' | 'edit'): ConnectionInput {
  if (mode === 'edit' && !input.id) {
    throw new Error('Connection id is required for edits.');
  }

  if (input.type === 'sqlite') {
    if (!input.name.trim()) {
      throw new Error('Connection name is required.');
    }
    if (!input.filePath.trim()) {
      throw new Error('SQLite database file is required.');
    }

    return {
      ...input,
      id: mode === 'edit' ? input.id : undefined,
      name: input.name.trim(),
      filePath: input.filePath.trim(),
    };
  }

  if (!input.name.trim()) {
    throw new Error('Connection name is required.');
  }
  if (!input.host.trim()) {
    throw new Error('MySQL host is required.');
  }
  if (!input.user.trim()) {
    throw new Error('MySQL user is required.');
  }
  if (!input.database.trim()) {
    throw new Error('MySQL database is required.');
  }

  return {
    ...input,
    id: mode === 'edit' ? input.id : undefined,
    name: input.name.trim(),
    host: input.host.trim(),
    user: input.user.trim(),
    database: input.database.trim(),
    port: Number.isFinite(input.port) && input.port > 0 ? input.port : 3306,
  };
}

function toUserError(error: unknown): { message: string; details?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;

    if (code === 'ER_ACCESS_DENIED_ERROR') {
      return { message: 'MySQL access denied. Check username/password and privileges.', details: error.message };
    }

    if (code === 'ECONNREFUSED') {
      return { message: 'MySQL connection refused. Check host, port, and network access.', details: error.message };
    }

    if (code === 'SQLITE_CANTOPEN') {
      return { message: 'Unable to open SQLite file. Verify path and file permissions.', details: error.message };
    }

    if (error.message.toLowerCase().includes('database is locked')) {
      return {
        message: 'SQLite database is locked by another process. Retry after concurrent writes finish.',
        details: error.message,
      };
    }

    return { message: error.message, details: error.stack };
  }

  return { message: 'Unknown error.' };
}

function createNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}
