import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { registerLanguageModelTools } from './ai/lmTools';
import { DbClientManager } from './db/clientManager';
import { ConnectionStore } from './state/connectionStore';
import { QueryHistoryStore } from './state/queryHistoryStore';
import { ExplorerViewProvider } from './webview/explorerPanel';
import { QueryPanelManager } from './webview/queryPanelManager';
import { SqlDocumentRunner } from './webview/sqlDocumentRunner';
import { TablePanelManager } from './webview/tablePanelManager';

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);
  const queryHistory = new QueryHistoryStore(context);
  const clientManager = new DbClientManager(connectionStore);
  const tablePanels = new TablePanelManager(context, connectionStore, clientManager);
  const queryPanels = new QueryPanelManager(context, connectionStore, clientManager, tablePanels, queryHistory);
  const explorer = new ExplorerViewProvider(context, connectionStore, clientManager, tablePanels, queryPanels);
  const sqlRunner = new SqlDocumentRunner(connectionStore, queryPanels);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerViewProvider.viewId, explorer, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbExplorer.open', () => explorer.focus()),
    vscode.commands.registerCommand('dbExplorer.refresh', async () => {
      await Promise.all([explorer.refresh(), tablePanels.refreshAll()]);
    }),
    vscode.commands.registerCommand('dbExplorer.addConnection', () => {
      explorer.requestAddConnection();
    }),
    vscode.commands.registerCommand('dbExplorer.clearQueryHistory', async () => {
      await queryHistory.clear();
      void vscode.window.showInformationMessage('OpenVSDB query history cleared.');
    }),
  );

  sqlRunner.register(context);
  registerLanguageModelTools(context, connectionStore, clientManager);

  // Deep links: vscode://<extension-id>/open?connection=<name-or-id>
  // [&schema=…&table=…&type=view] — opens a table grid, or a query console
  // when no table is given.
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri) => {
        if (uri.path !== '/open') {
          return;
        }

        const params = new URLSearchParams(uri.query);
        const target = params.get('connection');
        const connections = await connectionStore.listConnections();
        const connection = connections.find(
          (item) => item.id === target || item.name.toLowerCase() === (target ?? '').toLowerCase(),
        );
        if (!connection) {
          void vscode.window.showErrorMessage(`OpenVSDB: no connection matching "${target ?? ''}".`);
          return;
        }

        const table = params.get('table');
        if (!table) {
          await queryPanels.openQueryPanel(connection.id);
          return;
        }

        await tablePanels.openTable({
          connectionId: connection.id,
          schema: params.get('schema') || (connection.type === 'mysql' ? connection.database : 'main'),
          objectName: table,
          objectType: params.get('type') === 'view' ? 'view' : 'table',
          pageSize: 50,
        });
      },
    }),
  );

  // Dev loop: when the esbuild watcher rewrites dist/, reload any open webview
  // panels so the new bundles are picked up without restarting the host.
  // Note: fs.watch, not vscode.workspace.createFileSystemWatcher — the latter
  // watches the Extension Development Host's *workspace*, not this extension's
  // install directory.
  if (context.extensionMode === vscode.ExtensionMode.Development) {
    try {
      const distDir = path.join(context.extensionPath, 'dist');
      let debounce: NodeJS.Timeout | undefined;
      const watcher = fs.watch(distDir, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
          explorer.reloadWebview();
          tablePanels.reloadWebviews();
          queryPanels.reloadWebviews();
        }, 300);
      });

      context.subscriptions.push(
        new vscode.Disposable(() => {
          clearTimeout(debounce);
          watcher.close();
        }),
      );
    } catch {
      // dist/ may not exist before the first build; skip auto-reload silently.
    }
  }

  context.subscriptions.push(
    new vscode.Disposable(() => {
      explorer.dispose();
      tablePanels.dispose();
      queryPanels.dispose();
      void clientManager.disposeAll();
    }),
  );
}

export function deactivate(): void {
  // Resources are disposed through extension subscriptions.
}
