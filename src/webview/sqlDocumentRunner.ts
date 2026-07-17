import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConnectionStore } from '../state/connectionStore';
import { ConnectionMeta } from '../types';
import { QueryPanelManager } from './queryPanelManager';
import { toUserError } from './utils';

/**
 * Lets real `.sql` editors run against a connection: a status-bar picker and a
 * CodeLens bind a document to a connection, and "Run" executes the selection
 * (or the whole script) through the shared query pipeline into a results-only
 * panel beside the editor. Using native documents means multi-cursor, vim
 * extensions, SQL language servers, and Copilot all work on the SQL itself.
 */
export class SqlDocumentRunner implements vscode.Disposable {
  /** Document URI → connection id. In-memory; bindings are per-session. */
  private readonly bindings = new Map<string, string>();
  private readonly statusBar: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly codeLensEmitter = new vscode.EventEmitter<void>();

  constructor(
    private readonly connectionStore: ConnectionStore,
    private readonly queryPanels: QueryPanelManager,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.statusBar.command = 'dbExplorer.bindSqlDocument';
  }

  register(context: vscode.ExtensionContext): void {
    this.disposables.push(
      vscode.commands.registerCommand('dbExplorer.runSqlDocument', () => this.runActiveDocument()),
      vscode.commands.registerCommand('dbExplorer.bindSqlDocument', () => this.bindActiveDocument()),
      vscode.languages.registerCodeLensProvider({ language: 'sql' }, this.buildCodeLensProvider()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatusBar()),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.bindings.delete(document.uri.toString());
      }),
      this.statusBar,
      this.codeLensEmitter,
    );
    context.subscriptions.push(this);

    this.updateStatusBar();
  }

  dispose(): void {
    vscode.Disposable.from(...this.disposables).dispose();
    this.disposables.length = 0;
  }

  private buildCodeLensProvider(): vscode.CodeLensProvider {
    return {
      onDidChangeCodeLenses: this.codeLensEmitter.event,
      provideCodeLenses: async (document) => {
        const range = new vscode.Range(0, 0, 0, 0);
        const bound = await this.boundConnection(document);

        if (!bound) {
          return [
            new vscode.CodeLens(range, {
              title: '$(database) Select OpenVSDB connection…',
              command: 'dbExplorer.bindSqlDocument',
            }),
          ];
        }

        return [
          new vscode.CodeLens(range, {
            title: `$(play) Run on ${bound.name}`,
            tooltip: 'Run the whole script (or the selection) on this connection',
            command: 'dbExplorer.runSqlDocument',
          }),
          new vscode.CodeLens(range, {
            title: `${describeEnvironment(bound)}$(database) ${bound.name} (change)`,
            command: 'dbExplorer.bindSqlDocument',
          }),
        ];
      },
    };
  }

  private async runActiveDocument(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql file to run it with OpenVSDB.');
      return;
    }

    let connection = await this.boundConnection(editor.document);
    if (!connection) {
      connection = await this.bindActiveDocument();
      if (!connection) {
        return;
      }
    }

    const selection = editor.selection;
    const sql = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    if (!sql.trim()) {
      void vscode.window.showInformationMessage('Nothing to run — the document is empty.');
      return;
    }

    try {
      await this.queryPanels.runSqlOnConnection(
        connection.id,
        sql,
        path.basename(editor.document.fileName),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(toUserError(error).message);
    }
  }

  private async bindActiveDocument(): Promise<ConnectionMeta | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      void vscode.window.showInformationMessage('Open a .sql file to bind it to a connection.');
      return undefined;
    }

    const connections = await this.connectionStore.listConnections();
    if (connections.length === 0) {
      void vscode.window.showInformationMessage('No OpenVSDB connections yet — add one in the sidebar.');
      return undefined;
    }

    const picked = await vscode.window.showQuickPick(
      connections.map((connection) => ({
        label: `${describeEnvironment(connection)}${connection.name}`,
        description:
          connection.type === 'mysql'
            ? `mysql · ${connection.host}:${connection.port}/${connection.database}`
            : `sqlite · ${connection.filePath}`,
        connection,
      })),
      { title: 'Run this SQL file on…', placeHolder: 'Choose a connection' },
    );

    if (!picked) {
      return undefined;
    }

    this.bindings.set(editor.document.uri.toString(), picked.connection.id);
    this.updateStatusBar();
    this.codeLensEmitter.fire();
    return picked.connection;
  }

  private async boundConnection(document: vscode.TextDocument): Promise<ConnectionMeta | undefined> {
    const connectionId = this.bindings.get(document.uri.toString());
    if (!connectionId) {
      return undefined;
    }

    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      // Connection was removed since binding.
      this.bindings.delete(document.uri.toString());
    }
    return connection;
  }

  private updateStatusBar(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'sql') {
      this.statusBar.hide();
      return;
    }

    void this.boundConnection(editor.document).then((connection) => {
      this.statusBar.text = connection
        ? `$(database) ${describeEnvironment(connection)}${connection.name}`
        : '$(database) OpenVSDB: Select connection';
      this.statusBar.tooltip = connection
        ? `SQL runs on "${connection.name}" — click to change`
        : 'Bind this SQL file to an OpenVSDB connection';
      this.statusBar.show();
    });
  }
}

function describeEnvironment(connection: ConnectionMeta): string {
  switch (connection.environment) {
    case 'prod':
      return '[PROD] ';
    case 'staging':
      return '[staging] ';
    case 'local':
      return '[local] ';
    default:
      return '';
  }
}
