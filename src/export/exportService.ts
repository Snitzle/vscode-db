import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DatabaseClient } from '../db/client';
import { FilterSpec, RowData, SortSpec, TableInfo } from '../types';
import { EXPORT_FORMATS, ExportFormat, ExportTableData, renderExport, sqlInsertStatements } from './extractors';

/** The table view an export starts from — current page, sort, and filters. */
export interface ExportTarget {
  schema: string;
  table: string;
  objectType: 'table' | 'view';
  page: number;
  pageSize: number;
  sort?: SortSpec[];
  filters?: FilterSpec[];
  where?: string;
}

type ExportScope = 'selection' | 'page' | 'table';

const DUMP_PAGE_SIZE = 1000;

/**
 * Drive the export QuickPick flow (scope → format → destination) for a table
 * panel. Returns a status message for the webview, or undefined if the user
 * cancelled a step.
 */
export async function promptAndExportTable(
  client: DatabaseClient,
  target: ExportTarget,
  selection: RowData[],
): Promise<string | undefined> {
  const scope = await pickScope(selection.length);
  if (!scope) {
    return undefined;
  }

  const format = await pickFormat();
  if (!format) {
    return undefined;
  }

  const destination = await pickDestination();
  if (!destination) {
    return undefined;
  }

  const data = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting ${target.schema}.${target.table}…` },
    () => collectTableData(client, target, scope, selection),
  );

  const text = renderExport(format.format, data, client.dialect);
  const rowsLabel = `${data.rows.length} row${data.rows.length === 1 ? '' : 's'}`;

  if (destination === 'clipboard') {
    await vscode.env.clipboard.writeText(text);
    return `Copied ${rowsLabel} to the clipboard as ${format.label}.`;
  }

  const uri = await vscode.window.showSaveDialog({
    defaultUri: suggestedUri(`${target.schema}.${target.table}.${format.extension}`),
    saveLabel: 'Export',
  });
  if (!uri) {
    return undefined;
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
  return `Exported ${rowsLabel} to ${uri.fsPath}.`;
}

/**
 * Dump every table (DDL + INSERTs) and view (DDL) of the connection into one
 * .sql file. Returns the saved path, or undefined if the user cancelled.
 */
export async function exportDatabaseDump(
  client: DatabaseClient,
  connectionName: string,
): Promise<string | undefined> {
  const uri = await vscode.window.showSaveDialog({
    defaultUri: suggestedUri(`${sanitizeFileName(connectionName)}.sql`),
    saveLabel: 'Export database',
    filters: { SQL: ['sql'] },
  });
  if (!uri) {
    return undefined;
  }

  const script = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Exporting database "${connectionName}"…` },
    (progress) => buildDatabaseDump(client, progress),
  );

  await vscode.workspace.fs.writeFile(uri, Buffer.from(script, 'utf8'));
  return uri.fsPath;
}

async function pickScope(selectionCount: number): Promise<ExportScope | undefined> {
  const items: Array<vscode.QuickPickItem & { scope: ExportScope }> = [];
  if (selectionCount > 0) {
    items.push({
      label: `Selection (${selectionCount} row${selectionCount === 1 ? '' : 's'})`,
      scope: 'selection',
    });
  }
  items.push(
    { label: 'Current page', scope: 'page' },
    { label: 'Entire table', description: 'honours the active filters and sort', scope: 'table' },
  );

  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'What should be exported?' });
  return picked?.scope;
}

async function pickFormat(): Promise<(typeof EXPORT_FORMATS)[number] | undefined> {
  const items = EXPORT_FORMATS.map((entry) => ({ label: entry.label, entry }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Export format' });
  return picked?.entry;
}

async function pickDestination(): Promise<'file' | 'clipboard' | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(save) Save to file', destination: 'file' as const },
      { label: '$(clippy) Copy to clipboard', destination: 'clipboard' as const },
    ],
    { placeHolder: 'Export destination' },
  );
  return picked?.destination;
}

async function collectTableData(
  client: DatabaseClient,
  target: ExportTarget,
  scope: ExportScope,
  selection: RowData[],
): Promise<ExportTableData> {
  if (scope === 'selection') {
    const info = await client.getTableInfo(target.schema, target.table, target.objectType);
    return toExportData(info, selection);
  }

  if (scope === 'page') {
    const result = await client.queryTableRows(
      {
        schema: target.schema,
        table: target.table,
        page: target.page,
        pageSize: target.pageSize,
        sort: target.sort,
        filters: target.filters,
        where: target.where,
      },
      target.objectType,
    );
    return toExportData(result.info, result.rows);
  }

  const rows: RowData[] = [];
  let info: TableInfo | undefined;
  for (let page = 0; ; page += 1) {
    const result = await client.queryTableRows(
      {
        schema: target.schema,
        table: target.table,
        page,
        pageSize: DUMP_PAGE_SIZE,
        sort: target.sort,
        filters: target.filters,
        where: target.where,
      },
      target.objectType,
    );
    info = result.info;
    rows.push(...result.rows);
    if (result.rows.length < DUMP_PAGE_SIZE) {
      break;
    }
  }

  return toExportData(info as TableInfo, rows);
}

function toExportData(info: TableInfo, rows: RowData[]): ExportTableData {
  const columns = info.columns.map((column) => column.name);
  return {
    schema: info.schema,
    table: info.name,
    columns,
    rows: rows.map((row) => columns.map((column) => row.values[column] ?? null)),
  };
}

async function buildDatabaseDump(
  client: DatabaseClient,
  progress: vscode.Progress<{ message?: string }>,
): Promise<string> {
  const lines: string[] = [`-- Database dump generated by OpenVSDB`];
  if (client.dialect === 'mysql') {
    lines.push('SET FOREIGN_KEY_CHECKS=0;');
  } else {
    lines.push('PRAGMA foreign_keys=OFF;', 'BEGIN TRANSACTION;');
  }

  const schemas = await client.listSchemas();
  const views: Array<{ schema: string; name: string }> = [];

  for (const schema of schemas) {
    const objects = await client.listObjects(schema);

    for (const object of objects) {
      if (object.type === 'view') {
        views.push({ schema, name: object.name });
        continue;
      }

      progress.report({ message: `${schema}.${object.name}` });
      lines.push('', `-- Table ${schema}.${object.name}`);
      lines.push(await tableCreateStatement(client, schema, object.name));

      const data = await collectTableData(
        client,
        {
          schema,
          table: object.name,
          objectType: 'table',
          page: 0,
          pageSize: DUMP_PAGE_SIZE,
        },
        'table',
        [],
      );
      lines.push(...sqlInsertStatements(data, client.dialect));
    }
  }

  for (const view of views) {
    progress.report({ message: `${view.schema}.${view.name}` });
    lines.push('', `-- View ${view.schema}.${view.name}`);
    const ddl = await client.getDdl(view.schema, view.name, 'view');
    lines.push(ensureTerminated(ddl.trim()));
  }

  if (client.dialect === 'mysql') {
    lines.push('', 'SET FOREIGN_KEY_CHECKS=1;');
  } else {
    lines.push('', 'COMMIT;', 'PRAGMA foreign_keys=ON;');
  }

  return `${lines.join('\n')}\n`;
}

async function tableCreateStatement(client: DatabaseClient, schema: string, table: string): Promise<string> {
  let ddl = await client.getDdl(schema, table, 'table');
  // The SQLite client appends PRAGMA info as trailing comment blocks; keep only
  // the CREATE statement so the dump stays executable.
  ddl = ddl.split('\n\n-- PRAGMA table_info')[0].trim();
  return ensureTerminated(ddl);
}

function ensureTerminated(sql: string): string {
  return sql.endsWith(';') ? sql : `${sql};`;
}

function suggestedUri(fileName: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folder
    ? vscode.Uri.joinPath(folder, fileName)
    : vscode.Uri.file(path.join(os.homedir(), fileName));
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^a-z0-9-_. ]/gi, '_').trim();
  return cleaned || 'database';
}
