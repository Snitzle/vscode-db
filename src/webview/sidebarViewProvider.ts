import * as vscode from 'vscode';
import { DbClientManager } from '../db/clientManager';
import { ConnectionStore } from '../state/connectionStore';
import { ConnectionInput, ConnectionMeta, ConnectionTreeNode } from '../types';
import { SidebarExtensionEvent, SidebarWebviewRequest } from './protocol';
import { TablePanelManager } from './tablePanelManager';
import { renderWebviewHtml, toUserError } from './utils';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'dbExplorer.sidebar';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    private readonly tablePanels: TablePanelManager,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    view.webview.html = renderWebviewHtml(this.context, view.webview, {
      scriptFile: 'main.js',
      title: 'DB Explorer',
      surface: 'sidebar',
    });

    const messageDisposable = view.webview.onDidReceiveMessage(async (message: SidebarWebviewRequest) => {
      await this.handleMessage(message);
    });

    const disposeDisposable = view.onDidDispose(() => {
      this.view = undefined;
    });

    this.disposables.push(messageDisposable, disposeDisposable);
  }

  async refresh(): Promise<void> {
    await this.postState();
  }

  requestAddConnection(): void {
    this.postEvent({ kind: 'triggerAddConnection' });
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
  }

  private async handleMessage(message: SidebarWebviewRequest): Promise<void> {
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
          await this.tablePanels.openTable({
            connectionId: message.connectionId,
            schema: message.schema,
            objectName: message.objectName,
            objectType: message.objectType,
            pageSize: message.pageSize,
          });
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

    await Promise.all([this.postState(requestId), this.tablePanels.refreshConnection(saved.id)]);
  }

  private async removeConnection(connectionId: string, requestId?: string): Promise<void> {
    await this.connectionStore.removeConnection(connectionId);
    await this.clientManager.invalidate(connectionId);
    this.tablePanels.closeConnectionPanels(connectionId);

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

  private postEvent(event: SidebarExtensionEvent, requestId?: string): void {
    if (!this.view) {
      return;
    }

    void this.view.webview.postMessage({
      ...event,
      requestId,
    });
  }

  private assertNever(_message: never): never {
    throw new Error('Unhandled sidebar webview request.');
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
