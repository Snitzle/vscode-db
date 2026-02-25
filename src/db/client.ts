import {
  DbObject,
  DeleteRowsRequest,
  InsertRowRequest,
  TableInfo,
  TableQuery,
  TableQueryResult,
  UpdateRowsRequest,
} from '../types';

export interface DatabaseClient {
  readonly dialect: 'mysql' | 'sqlite';

  dispose(): Promise<void>;

  listSchemas(): Promise<string[]>;

  listObjects(schema: string): Promise<DbObject[]>;

  getTableInfo(schema: string, name: string, objectType: 'table' | 'view'): Promise<TableInfo>;

  queryTableRows(
    query: TableQuery,
    objectType: 'table' | 'view',
  ): Promise<TableQueryResult>;

  insertRow(request: InsertRowRequest): Promise<void>;

  updateRows(request: UpdateRowsRequest): Promise<void>;

  deleteRows(request: DeleteRowsRequest): Promise<void>;

  getDdl(schema: string, objectName: string, objectType: 'table' | 'view'): Promise<string>;
}
