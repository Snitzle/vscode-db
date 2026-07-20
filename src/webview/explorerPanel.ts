import * as vscode from 'vscode';
import { DbClientManager } from '../db/clientManager';
import { testConnection } from '../db/testConnection';
import { promptAndExportDatabase } from '../export/exportService';
import { splitSqlStatements } from '../sql/statements';
import { ConnectionStore } from '../state/connectionStore';
import { ConnectionInput, ConnectionMeta, ConnectionTreeNode } from '../types';
import { SidebarExtensionEvent, SidebarWebviewRequest } from './protocol';
import { QueryPanelManager } from './queryPanelManager';
import { TablePanelManager } from './tablePanelManager';
import { renderWebviewHtml, toUserError } from './utils';

/**
 * The Database Explorer as a sidebar webview view. Hosts connection management
 * and the schema tree; opening a table delegates to {@link TablePanelManager},
 * which opens the grid as an editor tab. The webview persists its own UI state
 * (expanded schemas, selection, filter) via the webview state API, and the view
 * is registered with `retainContextWhenHidden` so switching views is cheap.
 */
export class ExplorerViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'dbExplorer.home';

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pendingAddConnection = false;
  /** Last explicit-connect failure per connection, shown on the tree card. */
  private readonly connectErrors = new Map<string, string>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionStore: ConnectionStore,
    private readonly clientManager: DbClientManager,
    private readonly tablePanels: TablePanelManager,
    private readonly queryPanels: QueryPanelManager,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
      ],
    };
    webviewView.webview.html = this.buildHtml(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (message: SidebarWebviewRequest) => {
        await this.handleMessage(message);
        if (message.kind === 'ready' && this.pendingAddConnection) {
          this.pendingAddConnection = false;
          this.postEvent({ kind: 'triggerAddConnection' });
        }
      }),
      webviewView.onDidDispose(() => {
        this.view = undefined;
        vscode.Disposable.from(...this.disposables).dispose();
        this.disposables.length = 0;
      }),
    );
  }

  /** Reveal the explorer view in the sidebar (resolving it if needed). */
  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${ExplorerViewProvider.viewId}.focus`);
  }

  async refresh(): Promise<void> {
    if (this.view) {
      await this.postState();
    }
  }

  /** Dev-only: re-render the webview HTML so a rebuilt bundle is picked up. */
  reloadWebview(): void {
    if (this.view) {
      this.view.webview.html = this.buildHtml(this.view.webview);
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    return renderWebviewHtml(this.context, webview, {
      scriptFile: 'dist/main.js',
      styleFiles: ['media/main.css', 'dist/main.css'],
      title: 'Database Explorer',
      surface: 'sidebar',
    });
  }

  requestAddConnection(): void {
    if (this.view) {
      this.view.show?.(false);
      this.postEvent({ kind: 'triggerAddConnection' });
      return;
    }

    // Defer until the view resolves and its webview signals it is ready.
    this.pendingAddConnection = true;
    void this.focus();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
    this.view = undefined;
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

        case 'reorderConnections':
          await this.connectionStore.reorderConnections(message.orderedIds);
          await this.postState(message.requestId);
          return;

        case 'connectConnection':
          await this.connectConnection(message.connectionId, message.requestId);
          return;

        case 'disconnectConnection':
          // Closes the client (pools, SSH tunnels); open grids/query panels on
          // this connection stay open and will reconnect on their next action.
          await this.clientManager.invalidate(message.connectionId);
          this.connectErrors.delete(message.connectionId);
          await this.postState(message.requestId);
          return;

        case 'moveConnection':
          await this.connectionStore.moveConnection(message.connectionId, message.folderId, message.orderedIds);
          await this.postState(message.requestId);
          return;

        case 'createFolder':
          await this.createFolder(message.requestId);
          return;

        case 'renameFolder':
          await this.renameFolder(message.folderId, message.requestId);
          return;

        case 'removeFolder':
          await this.removeFolder(message.folderId, message.requestId);
          return;

        case 'reorderFolders':
          await this.connectionStore.reorderFolders(message.orderedIds);
          await this.postState(message.requestId);
          return;

        case 'pickSqliteFile': {
          const filePath = await this.pickSqliteFile();
          this.postEvent({ kind: 'sqliteFilePicked', filePath }, message.requestId);
          return;
        }

        case 'selectConnectionForEdit':
          await this.selectConnectionForEdit(message.connectionId, message.requestId);
          return;

        case 'exportDatabase':
          await this.exportDatabase(message.connectionId, message.requestId);
          return;

        case 'importSql':
          await this.importSql(message.connectionId, message.requestId);
          return;

        case 'openQueryPanel':
          await this.queryPanels.openQueryPanel(message.connectionId);
          return;

        case 'testConnection': {
          const result = await testConnection(
            message.connection,
            () =>
              message.connection.type === 'mysql' && message.connection.id
                ? this.connectionStore.getMySqlPassword(message.connection.id)
                : Promise.resolve(undefined),
            () =>
              message.connection.type === 'mysql' && message.connection.id
                ? this.connectionStore.getSshSecret(message.connection.id)
                : Promise.resolve(undefined),
          );
          this.postEvent(
            { kind: 'testConnectionResult', ok: result.ok, message: result.message },
            message.requestId,
          );
          return;
        }

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
    const [tree, connections, folders] = await Promise.all([
      this.buildTree(),
      this.connectionStore.listConnections(),
      this.connectionStore.listFolders(),
    ]);
    this.postEvent({ kind: 'state', tree, connections, folders }, requestId);
  }

  // Folder names come from native input boxes: webview prompt() is blocked in
  // the VS Code webview sandbox, same as the confirmation modals.
  private async createFolder(requestId?: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: 'Folder name',
      placeHolder: 'e.g. Eventwise, Acme Mobile',
      validateInput: (value) => (value.trim() ? undefined : 'Folder name is required.'),
    });
    if (name === undefined) {
      return;
    }

    await this.connectionStore.createFolder(name.trim());
    await this.postState(requestId);
  }

  private async renameFolder(folderId: string, requestId?: string): Promise<void> {
    const folder = await this.connectionStore.getFolder(folderId);
    if (!folder) {
      throw new Error('Folder not found.');
    }

    const name = await vscode.window.showInputBox({
      prompt: 'Folder name',
      value: folder.name,
      validateInput: (value) => (value.trim() ? undefined : 'Folder name is required.'),
    });
    if (name === undefined) {
      return;
    }

    await this.connectionStore.renameFolder(folderId, name.trim());
    await this.postState(requestId);
  }

  private async removeFolder(folderId: string, requestId?: string): Promise<void> {
    const folder = await this.connectionStore.getFolder(folderId);
    if (!folder) {
      throw new Error('Folder not found.');
    }

    const choice = await vscode.window.showWarningMessage(
      `Remove folder "${folder.name}"? Its connections move back to the top level.`,
      { modal: true },
      'Remove folder',
    );
    if (choice !== 'Remove folder') {
      return;
    }

    await this.connectionStore.removeFolder(folderId);
    await this.postState(requestId);
  }

  private async buildTree(): Promise<ConnectionTreeNode[]> {
    const connections = await this.connectionStore.listConnections();
    return Promise.all(connections.map((connection) => this.buildConnectionNode(connection)));
  }

  private async buildConnectionNode(connection: ConnectionMeta): Promise<ConnectionTreeNode> {
    // No client yet: stay disconnected instead of eagerly connecting to every
    // database when the sidebar loads. A failed explicit connect is remembered
    // so the card can show why.
    if (!this.clientManager.hasClient(connection.id)) {
      const lastError = this.connectErrors.get(connection.id);
      return {
        connectionId: connection.id,
        connectionType: connection.type,
        name: connection.name,
        folderId: connection.folderId,
        environment: connection.environment,
        status: lastError ? 'error' : 'disconnected',
        message: lastError,
        schemas: [],
      };
    }

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
        folderId: connection.folderId,
        environment: connection.environment,
        status: 'connected',
        schemas: schemaNodes,
      };
    } catch (error) {
      return {
        connectionId: connection.id,
        connectionType: connection.type,
        name: connection.name,
        folderId: connection.folderId,
        environment: connection.environment,
        status: 'error',
        message: toUserError(error).message,
        schemas: [],
      };
    }
  }

  /**
   * Connect (or reconnect) one connection. The client is rebuilt from scratch
   * so this doubles as a "reload connection": fresh client, fresh schema list.
   */
  private async connectConnection(connectionId: string, requestId?: string): Promise<void> {
    await this.clientManager.invalidate(connectionId);
    try {
      await this.clientManager.getClient(connectionId);
      this.connectErrors.delete(connectionId);
    } catch (error) {
      this.connectErrors.set(connectionId, toUserError(error).message);
    }
    await this.postState(requestId);
  }

  private async saveConnection(
    input: ConnectionInput,
    mode: 'add' | 'edit',
    requestId?: string,
  ): Promise<void> {
    const normalized = normalizeConnectionInput(input, mode);
    const saved = await this.connectionStore.upsertConnection(normalized);
    await this.clientManager.invalidate(saved.id);

    // Connect right away: the user just acted on this connection and expects
    // to see its tree (or the failure) without a second click.
    try {
      await this.clientManager.getClient(saved.id);
      this.connectErrors.delete(saved.id);
    } catch (error) {
      this.connectErrors.set(saved.id, toUserError(error).message);
    }

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
    this.connectErrors.delete(connectionId);
    this.tablePanels.closeConnectionPanels(connectionId);
    this.queryPanels.closeConnectionPanels(connectionId);

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

  private async importSql(connectionId: string, requestId?: string): Promise<void> {
    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      throw new Error('Connection not found.');
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Import SQL',
      filters: { SQL: ['sql'], 'All Files': ['*'] },
    });
    const fileUri = selected?.[0];
    if (!fileUri) {
      return;
    }

    const bytes = await vscode.workspace.fs.readFile(fileUri);
    const sql = Buffer.from(bytes).toString('utf8');
    const statementCount = splitSqlStatements(sql).length;
    if (statementCount === 0) {
      this.postEvent({ kind: 'info', message: 'The selected file contains no SQL statements.' }, requestId);
      return;
    }

    const fileName = fileUri.path.split('/').pop() ?? 'file';
    const prodPrefix = connection.environment === 'prod' ? 'PRODUCTION: ' : '';
    const choice = await vscode.window.showWarningMessage(
      `${prodPrefix}Run ${statementCount} statement${statementCount === 1 ? '' : 's'} from "${fileName}" against "${connection.name}"? This may modify data and cannot be undone.`,
      { modal: true },
      'Run',
    );
    if (choice !== 'Run') {
      return;
    }

    const client = await this.clientManager.getClient(connectionId);
    const results = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Importing ${fileName} into "${connection.name}"…` },
      () => client.executeRaw(sql),
    );

    const affected = results.reduce((total, result) => total + (result.affectedRows ?? 0), 0);
    this.postEvent(
      {
        kind: 'info',
        message: `Import finished: ${results.length} statement${results.length === 1 ? '' : 's'}, ${affected} row${affected === 1 ? '' : 's'} affected.`,
      },
      requestId,
    );

    // New tables/data may exist now.
    await Promise.all([this.postState(requestId), this.tablePanels.refreshConnection(connectionId)]);
  }

  private async exportDatabase(connectionId: string, requestId?: string): Promise<void> {
    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      throw new Error('Connection not found.');
    }

    const client = await this.clientManager.getClient(connectionId);
    const outcome = await promptAndExportDatabase(client, connection.name);
    if (outcome) {
      this.postEvent({ kind: 'info', message: outcome }, requestId);
    }
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

  if (input.sshTunnel?.enabled) {
    if (!input.sshTunnel.host.trim()) {
      throw new Error('SSH host is required when the tunnel is enabled.');
    }
    if (!input.sshTunnel.user.trim()) {
      throw new Error('SSH user is required when the tunnel is enabled.');
    }
    if (input.sshTunnel.authMethod === 'key' && !input.sshTunnel.keyPath?.trim()) {
      throw new Error('SSH private key path is required for key authentication.');
    }
  }

  return {
    ...input,
    id: mode === 'edit' ? input.id : undefined,
    name: input.name.trim(),
    host: input.host.trim(),
    user: input.user.trim(),
    database: input.database.trim(),
    port: Number.isFinite(input.port) && input.port > 0 ? input.port : 3306,
    sshTunnel: input.sshTunnel?.enabled
      ? {
          ...input.sshTunnel,
          host: input.sshTunnel.host.trim(),
          user: input.sshTunnel.user.trim(),
          port:
            Number.isFinite(input.sshTunnel.port) && input.sshTunnel.port > 0 ? input.sshTunnel.port : 22,
          keyPath: input.sshTunnel.keyPath?.trim() || undefined,
        }
      : undefined,
  };
}
