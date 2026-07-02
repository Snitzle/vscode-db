import * as vscode from 'vscode';
import { DbClientManager } from '../db/clientManager';
import { ConnectionStore } from '../state/connectionStore';
import { ConnectionInput, ConnectionMeta, ConnectionTreeNode } from '../types';
import { SidebarExtensionEvent, SidebarWebviewRequest } from './protocol';
import { TablePanelManager } from './tablePanelManager';
import { renderWebviewHtml, toUserError } from './utils';

/**
 * The Database Explorer as a singleton editor tab (main window) rather than a
 * sidebar view. Hosts connection management and the schema tree; opening a table
 * delegates to {@link TablePanelManager}, which opens the grid as its own tab.
 */
export class ExplorerPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingAddConnection = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    private readonly tablePanels: TablePanelManager,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbExplorer.explorer',
      'Database Explorer',
      { preserveFocus: false, viewColumn: vscode.ViewColumn.Active },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media'),
          vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        ],
      },
    );

    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'database.svg');
    panel.webview.html = this.buildHtml(panel.webview);

    this.panel = panel;

    this.disposables.push(
      panel.webview.onDidReceiveMessage(async (message: SidebarWebviewRequest) => {
        await this.handleMessage(message);
        if (message.kind === 'ready' && this.pendingAddConnection) {
          this.pendingAddConnection = false;
          this.postEvent({ kind: 'triggerAddConnection' });
        }
      }),
      panel.onDidDispose(() => {
        this.panel = undefined;
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables.length = 0;
      }),
    );
  }

  async refresh(): Promise<void> {
    if (this.panel) {
      await this.postState();
    }
  }

  /** Dev-only: re-render the webview HTML so a rebuilt bundle is picked up. */
  reloadWebview(): void {
    if (this.panel) {
      this.panel.webview.html = this.buildHtml(this.panel.webview);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    return renderWebviewHtml(this.context, webview, {
      scriptFile: 'dist/main.js',
      styleFiles: ['media/main.css', 'dist/main.css'],
      title: 'Database Explorer',
      surface: 'panel',
    });
  }

  requestAddConnection(): void {
    const wasOpen = Boolean(this.panel);
    this.open();

    if (wasOpen) {
      this.postEvent({ kind: 'triggerAddConnection' });
    } else {
      // Defer until the freshly created webview signals it is ready.
      this.pendingAddConnection = true;
    }
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.panel?.dispose();
    this.panel = undefined;
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
    return Promise.all(connections.map((connection) => this.buildConnectionNode(connection)));
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
    const connection = await this.connectionStore.getConnection(connectionId);
    const name = connection?.name ?? 'this connection';
    const choice = await vscode.window.showWarningMessage(
      `Remove connection "${name}"?`,
      { modal: true },
      'Remove',
    );
    if (choice !== 'Remove') {
      return;
    }

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
    if (!this.panel) {
      return;
    }

    void this.panel.webview.postMessage({
      ...event,
      requestId,
    });
  }

  private assertNever(_message: never): never {
    throw new Error('Unhandled explorer webview request.');
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
