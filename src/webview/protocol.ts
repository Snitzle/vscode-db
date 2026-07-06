import {
  ConnectionInput,
  ConnectionMeta,
  ConnectionTreeNode,
  DeleteRowsRequest,
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
  | ({ kind: 'pickSqliteFile' } & RequestBase)
  | ({ kind: 'pickCertFile'; target: 'caPath' | 'certPath' | 'keyPath' } & RequestBase)
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
  | ({ kind: 'state'; tree: ConnectionTreeNode[]; connections: ConnectionMeta[] } & EventBase)
  | ({ kind: 'sqliteFilePicked'; filePath?: string } & EventBase)
  | ({ kind: 'certFilePicked'; target: 'caPath' | 'certPath' | 'keyPath'; filePath?: string } & EventBase)
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

export type QueryPanelRequest =
  | ({ kind: 'ready' } & RequestBase)
  | ({ kind: 'runQuery'; sql: string } & RequestBase)
  | ({ kind: 'exportResults'; statementIndex: number } & RequestBase);

export type QueryPanelEvent =
  | ({ kind: 'queryConfig'; connectionName: string; dialect: 'mysql' | 'sqlite' } & EventBase)
  | ({ kind: 'queryResults'; results: RawQueryResult[] } & EventBase)
  | ({ kind: 'info'; message: string } & EventBase)
  | ({ kind: 'error'; message: string; details?: string } & EventBase);
