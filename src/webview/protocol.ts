import {
  ConnectionInput,
  ConnectionMeta,
  ConnectionTreeNode,
  DeleteRowsRequest,
  InsertRowRequest,
  RowData,
  SortSpec,
  FilterSpec,
  TableInfo,
  UpdateRowsRequest,
} from '../types';

export interface RequestBase {
  requestId: string;
}

export type WebviewRequest =
  | ({ kind: 'ready' } & RequestBase)
  | ({ kind: 'refreshTree' } & RequestBase)
  | ({ kind: 'saveConnection'; mode: 'add' | 'edit'; connection: ConnectionInput } & RequestBase)
  | ({ kind: 'removeConnection'; connectionId: string } & RequestBase)
  | ({ kind: 'pickSqliteFile' } & RequestBase)
  | ({
      kind: 'openTable';
      connectionId: string;
      schema: string;
      objectName: string;
      objectType: 'table' | 'view';
      pageSize: number;
    } & RequestBase)
  | ({
      kind: 'queryTableRows';
      connectionId: string;
      schema: string;
      table: string;
      objectType: 'table' | 'view';
      page: number;
      pageSize: number;
      sort?: SortSpec;
      filter?: FilterSpec;
    } & RequestBase)
  | ({ kind: 'insertRow'; connectionId: string; payload: InsertRowRequest } & RequestBase)
  | ({
      kind: 'duplicateRow';
      connectionId: string;
      schema: string;
      table: string;
      row: RowData;
    } & RequestBase)
  | ({ kind: 'updateRows'; connectionId: string; payload: UpdateRowsRequest } & RequestBase)
  | ({ kind: 'deleteRows'; connectionId: string; payload: DeleteRowsRequest } & RequestBase)
  | ({
      kind: 'viewDdl';
      connectionId: string;
      schema: string;
      objectName: string;
      objectType: 'table' | 'view';
    } & RequestBase)
  | ({ kind: 'openDdlInEditor'; title: string; ddl: string } & RequestBase)
  | ({ kind: 'selectConnectionForEdit'; connectionId: string } & RequestBase);

export interface EventBase {
  requestId?: string;
}

export type ExtensionEvent =
  | ({ kind: 'state'; tree: ConnectionTreeNode[]; connections: ConnectionMeta[] } & EventBase)
  | ({ kind: 'sqliteFilePicked'; filePath?: string } & EventBase)
  | ({ kind: 'connectionSelectedForEdit'; connection: ConnectionMeta } & EventBase)
  | ({ kind: 'triggerAddConnection' } & EventBase)
  | ({
      kind: 'tableData';
      connectionId: string;
      info: TableInfo;
      rows: RowData[];
      page: number;
      pageSize: number;
      totalCount?: number;
      sort?: SortSpec;
      filter?: FilterSpec;
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
