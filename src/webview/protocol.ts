import {
  ConnectionEnvironment,
  ConnectionInput,
  ConnectionMeta,
  ConnectionTreeNode,
  DeleteRowsRequest,
  FolderMeta,
  InsertRowRequest,
  FilterSpec,
  RawQueryResult,
  RowData,
  SortSpec,
  TableInfo,
  UpdateRowsRequest,
} from '../types';

export interface RequestBase {
  requestId: string;
}

export type SidebarWebviewRequest =
  | ({ kind: 'ready' } & RequestBase)
  | ({ kind: 'refreshTree' } & RequestBase)
  | ({ kind: 'saveConnection'; mode: 'add' | 'edit'; connection: ConnectionInput } & RequestBase)
  | ({ kind: 'removeConnection'; connectionId: string } & RequestBase)
  | ({ kind: 'reorderConnections'; orderedIds: string[] } & RequestBase)
  | ({ kind: 'connectConnection'; connectionId: string } & RequestBase)
  | ({ kind: 'disconnectConnection'; connectionId: string } & RequestBase)
  | ({
      kind: 'moveConnection';
      connectionId: string;
      /** Destination folder, or null for the top level. */
      folderId: string | null;
      orderedIds: string[];
    } & RequestBase)
  | ({ kind: 'createFolder' } & RequestBase)
  | ({ kind: 'renameFolder'; folderId: string } & RequestBase)
  | ({ kind: 'removeFolder'; folderId: string } & RequestBase)
  | ({ kind: 'reorderFolders'; orderedIds: string[] } & RequestBase)
  | ({ kind: 'pickSqliteFile' } & RequestBase)
  | ({
      kind: 'openTable';
      connectionId: string;
      schema: string;
      objectName: string;
      objectType: 'table' | 'view';
      pageSize: number;
    } & RequestBase)
  | ({ kind: 'selectConnectionForEdit'; connectionId: string } & RequestBase)
  | ({ kind: 'exportDatabase'; connectionId: string } & RequestBase)
  | ({ kind: 'importSql'; connectionId: string } & RequestBase)
  | ({ kind: 'openQueryPanel'; connectionId: string } & RequestBase)
  | ({ kind: 'testConnection'; connection: ConnectionInput } & RequestBase);

export interface EventBase {
  requestId?: string;
}

export type SidebarExtensionEvent =
  | ({
      kind: 'state';
      tree: ConnectionTreeNode[];
      connections: ConnectionMeta[];
      folders: FolderMeta[];
    } & EventBase)
  | ({ kind: 'sqliteFilePicked'; filePath?: string } & EventBase)
  | ({ kind: 'connectionSelectedForEdit'; connection: ConnectionMeta } & EventBase)
  | ({ kind: 'triggerAddConnection' } & EventBase)
  | ({ kind: 'testConnectionResult'; ok: boolean; message: string } & EventBase)
  | ({ kind: 'info'; message: string } & EventBase)
  | ({ kind: 'error'; message: string; details?: string } & EventBase);

export type TablePanelRequest =
  | ({ kind: 'ready' } & RequestBase)
  | ({ kind: 'refreshTable' } & RequestBase)
  | ({
      kind: 'queryTableRows';
      page: number;
      pageSize: number;
      sort?: SortSpec[];
      filters?: FilterSpec[];
      where?: string;
    } & RequestBase)
  | ({ kind: 'insertRow'; payload: InsertRowRequest } & RequestBase)
  | ({ kind: 'duplicateRow'; row: RowData } & RequestBase)
  | ({ kind: 'updateRows'; payload: UpdateRowsRequest } & RequestBase)
  | ({ kind: 'deleteRows'; payload: DeleteRowsRequest } & RequestBase)
  | ({ kind: 'viewDdl' } & RequestBase)
  | ({ kind: 'openDdlInEditor'; title: string; ddl: string } & RequestBase)
  | ({ kind: 'exportTable'; selection: RowData[] } & RequestBase);

export type TablePanelEvent =
  | ({
      kind: 'tableData';
      connectionId: string;
      environment?: ConnectionEnvironment;
      info: TableInfo;
      rows: RowData[];
      page: number;
      pageSize: number;
      totalCount?: number;
      sort?: SortSpec[];
      filters?: FilterSpec[];
      where?: string;
    } & EventBase)
  | ({
      kind: 'ddl';
      connectionId: string;
      schema: string;
      objectName: string;
      objectType: 'table' | 'view';
      ddl: string;
    } & EventBase)
  | ({ kind: 'mutationApplied'; message: string } & EventBase)
  | ({ kind: 'info'; message: string } & EventBase)
  | ({ kind: 'error'; message: string; details?: string } & EventBase);

/** How one column of an editable query result maps back to its table. */
export interface QueryEditableColumn {
  name: string;
  /** False for key columns, auto-increments, and expressions/aliases. */
  editable: boolean;
  nullable?: boolean;
  dataType?: string;
}

/**
 * Attached to a query result when the statement was a simple single-table
 * SELECT whose rows can be updated in place. Aligned by index with
 * `queryResults.results`; null = read-only result.
 */
export interface QueryEditableInfo {
  schema: string;
  table: string;
  keyKind: 'primary' | 'unique' | 'rowid';
  keyColumns: string[];
  columns: QueryEditableColumn[];
}

export type QueryPanelRequest =
  | ({ kind: 'ready' } & RequestBase)
  | ({ kind: 'runQuery'; sql: string } & RequestBase)
  | ({ kind: 'updateQueryRows'; payload: UpdateRowsRequest } & RequestBase)
  | ({ kind: 'pickQueryHistory' } & RequestBase)
  | ({ kind: 'exportResults'; statementIndex: number } & RequestBase);

export type QueryPanelEvent =
  | ({
      kind: 'queryConfig';
      connectionName: string;
      dialect: 'mysql' | 'sqlite';
      environment?: ConnectionEnvironment;
      /** Results-only panels (bound .sql editors) hide the inline editor. */
      hideEditor?: boolean;
    } & EventBase)
  | ({
      kind: 'queryResults';
      results: RawQueryResult[];
      editable?: (QueryEditableInfo | null)[];
    } & EventBase)
  | ({ kind: 'insertSql'; sql: string } & EventBase)
  | ({ kind: 'mutationApplied'; message: string } & EventBase)
  | ({ kind: 'info'; message: string } & EventBase)
  | ({ kind: 'error'; message: string; details?: string } & EventBase);
