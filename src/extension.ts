import * as vscode from 'vscode';
import { DbClientManager } from './db/clientManager';
import { ConnectionStore } from './state/connectionStore';
import { SidebarViewProvider } from './webview/sidebarViewProvider';
import { TablePanelManager } from './webview/tablePanelManager';

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);
  const clientManager = new DbClientManager(connectionStore);
  const tablePanels = new TablePanelManager(context, connectionStore, clientManager);
  const provider = new SidebarViewProvider(context, connectionStore, clientManager, tablePanels);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarViewProvider.viewId, provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbExplorer.refresh', async () => {
      await Promise.all([provider.refresh(), tablePanels.refreshAll()]);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbExplorer.addConnection', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.dbExplorer');
      provider.requestAddConnection();
    }),
  );

  context.subscriptions.push(
    new vscode.Disposable(() => {
      provider.dispose();
      tablePanels.dispose();
      void clientManager.disposeAll();
    }),
  );
}

export function deactivate(): void {
  // Resources are disposed through extension subscriptions.
}
