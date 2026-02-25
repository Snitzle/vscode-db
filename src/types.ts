export type ConnectionType = 'mysql' | 'sqlite';

export interface BaseConnectionMeta {
  id: string;
  name: string;
  type: ConnectionType;
}

export interface MySqlSslOptions {
  enabled: boolean;
  rejectUnauthorized: boolean;
  caPath?: string;
  certPath?: string;
  keyPath?: string;
  serverName?: string;
}

export interface MySqlConnectionMeta extends BaseConnectionMeta {
  type: 'mysql';
  host: string;
  port: number;
  user: string;
  database: string;
  ssl?: MySqlSslOptions;
}

export interface SqliteConnectionMeta extends BaseConnectionMeta {
  type: 'sqlite';
  filePath: string;
}

export type ConnectionMeta = MySqlConnectionMeta | SqliteConnectionMeta;

export interface MySqlConnectionInput {
  id?: string;
  type: 'mysql';
  name: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  clearPassword?: boolean;
  database: string;
  ssl?: MySqlSslOptions;
}

export interface SqliteConnectionInput {
  id?: string;
  type: 'sqlite';
  name: string;
  filePath: string;
}

export type ConnectionInput = MySqlConnectionInput | SqliteConnectionInput;

export interface DbObject {
  schema: string;
  name: string;
  type: 'table' | 'view';
}

export interface SchemaNode {
  name: string;
  objects: DbObject[];
}

export interface ConnectionTreeNode {
  connectionId: string;
  connectionType: ConnectionType;
  name: string;
  status: 'connected' | 'error';
  message?: string;
  schemas: SchemaNode[];
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isUniqueKey: boolean;
  isAutoIncrement: boolean;
}

export type WritableKeyKind = 'primary' | 'unique' | 'rowid' | 'none';

export interface WritableKeyInfo {
  kind: WritableKeyKind;
  columns: string[];
  reason?: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  objectType: 'table' | 'view';
  columns: ColumnInfo[];
  writableKey: WritableKeyInfo;
  readOnly: boolean;
  readOnlyReason?: string;
}

export type Scalar = string | number | boolean | null;

export interface RowKey {
  kind: 'primary' | 'unique' | 'rowid';
  values: Record<string, Scalar>;
}

export interface RowData {
  key: RowKey | null;
  values: Record<string, Scalar>;
}

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull';

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value?: Scalar;
}

export interface TableQuery {
  schema: string;
  table: string;
  page: number;
  pageSize: number;
  sort?: SortSpec;
  filter?: FilterSpec;
  includeCount?: boolean;
}

export interface TableQueryResult {
  info: TableInfo;
  rows: RowData[];
  totalCount?: number;
  page: number;
  pageSize: number;
}

export interface RowUpdate {
  key: RowKey;
  changes: Record<string, Scalar>;
}

export interface InsertRowRequest {
  schema: string;
  table: string;
  values: Record<string, Scalar>;
}

export interface UpdateRowsRequest {
  schema: string;
  table: string;
  updates: RowUpdate[];
}

export interface DeleteRowsRequest {
  schema: string;
  table: string;
  keys: RowKey[];
}
