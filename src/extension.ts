import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DbClientManager } from './db/clientManager';
import { ConnectionStore } from './state/connectionStore';
import { ExplorerPanel } from './webview/explorerPanel';
import { TablePanelManager } from './webview/tablePanelManager';

export function activate(context: vscode.ExtensionContext): void {
  const connectionStore = new ConnectionStore(context);
  const clientManager = new DbClientManager(connectionStore);
  const tablePanels = new TablePanelManager(context, connectionStore, clientManager);
  const explorer = new ExplorerPanel(context, connectionStore, clientManager, tablePanels);

  // The activity-bar entry is a lightweight launcher: an empty tree whose welcome
  // content opens the Database Explorer in a main-window editor tab.
  const launcher = vscode.window.createTreeView('dbExplorer.home', {
    treeDataProvider: new LauncherTreeProvider(),
  });

  context.subscriptions.push(
    launcher,
    launcher.onDidChangeVisibility((event) => {
      if (event.visible) {
        explorer.open();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('dbExplorer.open', () => {
      explorer.open();
    }),
    vscode.commands.registerCommand('dbExplorer.refresh', async () => {
      await Promise.all([explorer.refresh(), tablePanels.refreshAll()]);
    }),
    vscode.commands.registerCommand('dbExplorer.addConnection', () => {
      explorer.requestAddConnection();
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
      void clientManager.disposeAll();
    }),
  );
}

export function deactivate(): void {
  // Resources are disposed through extension subscriptions.
}

class LauncherTreeProvider implements vscode.TreeDataProvider<never> {
  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }
}
