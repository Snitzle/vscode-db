import * as fs from 'node:fs';
import * as mysql from 'mysql2/promise';
import { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2';
import {
  ColumnInfo,
  DbObject,
  DeleteRowsRequest,
  InsertRowRequest,
  MySqlConnectionMeta,
  RawQueryResult,
  RowData,
  RowKey,
  Scalar,
  TableInfo,
  TableQuery,
  TableQueryResult,
  UpdateRowsRequest,
} from '../types';
import { DatabaseClient } from './client';
import { chooseWritableKey, UniqueIndexCandidate } from './keyStrategy';
import { toScalar } from './valueCodec';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../sql/identifier';
import { buildFilterClause, buildOrderByClause } from '../sql/queryFragments';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

/** Connection fields shared by saved metas and yet-unsaved form input. */
export interface MySqlTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  ssl?: MySqlConnectionMeta['ssl'];
  allowClearTextAuth?: boolean;
}

/**
 * Base mysql2 options for a target — shared between the long-lived pool and
 * the one-shot test-connection path so both authenticate identically.
 */
export function buildMySqlConnectionOptions(
  target: MySqlTarget,
  password: string | undefined,
): mysql.ConnectionOptions {
  const options: mysql.ConnectionOptions = {
    host: target.host,
    port: target.port,
    user: target.user,
    password,
    database: target.database,
    decimalNumbers: false,
    multipleStatements: true,
    ssl: buildMySqlSslConfig(target),
  };

  if (target.allowClearTextAuth) {
    // mysql_clear_password sends the password as a null-terminated string; it
    // is required by LDAP/PAM-backed servers and must be opted into.
    options.authPlugins = {
      mysql_clear_password: () => () => Buffer.from(`${password ?? ''}\0`, 'utf8'),
    };
  }

  return options;
}

function buildMySqlSslConfig(target: MySqlTarget): mysql.ConnectionOptions['ssl'] {
  if (!target.ssl?.enabled) {
    return undefined;
  }

  const sslOptions: Record<string, unknown> = {
    rejectUnauthorized: target.ssl.rejectUnauthorized,
  };

  if (target.ssl.caPath) {
    sslOptions.ca = fs.readFileSync(target.ssl.caPath, 'utf8');
  }

  if (target.ssl.certPath) {
    sslOptions.cert = fs.readFileSync(target.ssl.certPath, 'utf8');
  }

  if (target.ssl.keyPath) {
    sslOptions.key = fs.readFileSync(target.ssl.keyPath, 'utf8');
  }

  if (target.ssl.serverName) {
    sslOptions.servername = target.ssl.serverName;
  }

  return sslOptions as mysql.ConnectionOptions['ssl'];
}

export class MySqlClient implements DatabaseClient {
  public readonly dialect = 'mysql' as const;
  private readonly pool: mysql.Pool;

  constructor(
    private readonly connection: MySqlConnectionMeta,
    password: string | undefined,
    /** Extra teardown run after the pool closes (e.g. the SSH tunnel). */
    private readonly extraDisposal?: () => Promise<void>,
  ) {
    this.pool = mysql.createPool({
      ...buildMySqlConnectionOptions(connection, password),
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
    });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
    await this.extraDisposal?.();
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT SCHEMA_NAME FROM information_schema.schemata ORDER BY SCHEMA_NAME ASC',
    );

    return rows
      .map((row) => String(row.SCHEMA_NAME))
      .filter((schema) => !SYSTEM_SCHEMAS.has(schema));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `
        SELECT TABLE_NAME, TABLE_TYPE
        FROM information_schema.tables
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_TYPE ASC, TABLE_NAME ASC
      `,
      [schema],
    );

    return rows.map((row) => ({
      schema,
      name: String(row.TABLE_NAME),
      type: String(row.TABLE_TYPE).toUpperCase() === 'VIEW' ? 'view' : 'table',
    }));
  }

  async getTableInfo(schema: string, name: string, objectType: 'table' | 'view'): Promise<TableInfo> {
    const [columnRows] = await this.pool.execute<RowDataPacket[]>(
      `
        SELECT
          COLUMN_NAME,
          DATA_TYPE,
          COLUMN_TYPE,
          IS_NULLABLE,
          COLUMN_KEY,
          EXTRA
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION ASC
      `,
      [schema, name],
    );

    const uniqueCandidates = await this.loadUniqueIndexCandidates(schema, name);
    const primaryKeyColumns = columnRows
      .filter((row) => String(row.COLUMN_KEY) === 'PRI')
      .map((row) => String(row.COLUMN_NAME));

    const writableKey =
      objectType === 'view'
        ? {
            kind: 'none' as const,
            columns: [],
            reason: 'Views are read-only in this extension.',
          }
        : chooseWritableKey({
            primaryKeyColumns,
            uniqueIndexCandidates: uniqueCandidates,
            allowRowId: false,
          });

    const allUniqueColumns = new Set(uniqueCandidates.flatMap((candidate) => candidate.columns));

    const columns: ColumnInfo[] = columnRows.map((row) => ({
      name: String(row.COLUMN_NAME),
      dataType: String(row.COLUMN_TYPE ?? row.DATA_TYPE),
      nullable: String(row.IS_NULLABLE) === 'YES',
      isPrimaryKey: String(row.COLUMN_KEY) === 'PRI',
      isUniqueKey: allUniqueColumns.has(String(row.COLUMN_NAME)),
      isAutoIncrement: String(row.EXTRA).toLowerCase().includes('auto_increment'),
    }));

    const readOnly = writableKey.kind === 'none' || objectType === 'view';

    return {
      schema,
      name,
      objectType,
      columns,
      writableKey,
      readOnly,
      readOnlyReason: readOnly ? writableKey.reason ?? 'Read-only object.' : undefined,
    };
  }

  async queryTableRows(query: TableQuery, objectType: 'table' | 'view'): Promise<TableQueryResult> {
    const info = await this.getTableInfo(query.schema, query.table, objectType);
    const allowedColumns = new Set(info.columns.map((column) => column.name));
    const where = buildFilterClause('mysql', query, allowedColumns);
    const order = buildOrderByClause('mysql', query.sort, allowedColumns);
    const page = Number.isFinite(query.page) ? Math.max(0, Math.trunc(query.page)) : 0;
    const pageSize = Number.isFinite(query.pageSize) ? Math.max(1, Math.trunc(query.pageSize)) : 50;
    const offset = page * pageSize;

    const selectColumns = info.columns.map((column) => quoteIdentifier('mysql', column.name)).join(', ');
    const tableSql = quoteQualifiedIdentifier('mysql', query.schema, query.table);

    const sql = [
      `SELECT ${selectColumns} FROM ${tableSql}`,
      where.sql,
      order,
      `LIMIT ${pageSize} OFFSET ${offset}`,
    ]
      .filter((part) => part.length > 0)
      .join(' ');

    const params = [...where.params];
    const [rows] = await this.pool.execute<RowDataPacket[]>(sql, params);

    const dataRows: RowData[] = rows.map((row) => this.rowPacketToRowData(row, info));

    let totalCount: number | undefined;
    if (query.includeCount) {
      const countSql = [`SELECT COUNT(*) AS totalCount FROM ${tableSql}`, where.sql]
        .filter((part) => part.length > 0)
        .join(' ');
      const [countRows] = await this.pool.execute<RowDataPacket[]>(countSql, where.params);
      totalCount = Number(countRows[0]?.totalCount ?? 0);
    }

    return {
      info,
      rows: dataRows,
      totalCount,
      page,
      pageSize,
    };
  }

  async insertRow(request: InsertRowRequest): Promise<void> {
    const info = await this.getTableInfo(request.schema, request.table, 'table');
    if (info.readOnly) {
      throw new Error(info.readOnlyReason ?? 'Table is read-only.');
    }

    const writableColumns = info.columns.filter((column) => !column.isAutoIncrement);
    const writableSet = new Set(writableColumns.map((column) => column.name));
    const entries = Object.entries(request.values).filter(([column]) => writableSet.has(column));

    const tableSql = quoteQualifiedIdentifier('mysql', request.schema, request.table);

    if (entries.length === 0) {
      await this.pool.execute(`INSERT INTO ${tableSql} () VALUES ()`);
      return;
    }

    const columnSql = entries.map(([column]) => quoteIdentifier('mysql', column)).join(', ');
    const placeholders = entries.map(() => '?').join(', ');
    const params = entries.map(([, value]) => value);

    await this.pool.execute(`INSERT INTO ${tableSql} (${columnSql}) VALUES (${placeholders})`, params);
  }

  async updateRows(request: UpdateRowsRequest): Promise<void> {
    if (request.updates.length === 0) {
      return;
    }

    const info = await this.getTableInfo(request.schema, request.table, 'table');
    if (info.readOnly) {
      throw new Error(info.readOnlyReason ?? 'Table is read-only.');
    }

    const editableColumns = new Set(
      info.columns.filter((column) => !column.isAutoIncrement).map((column) => column.name),
    );

    const tableSql = quoteQualifiedIdentifier('mysql', request.schema, request.table);
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();

      for (const update of request.updates) {
        const entries = Object.entries(update.changes).filter(([column]) => editableColumns.has(column));
        if (entries.length === 0) {
          continue;
        }

        const setSql = entries.map(([column]) => `${quoteIdentifier('mysql', column)} = ?`).join(', ');
        const { whereSql, whereParams } = this.buildWhereFromRowKey(update.key);

        const params = [...entries.map(([, value]) => value), ...whereParams];
        const sql = `UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}`;

        await connection.execute(sql, params);
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async deleteRows(request: DeleteRowsRequest): Promise<void> {
    if (request.keys.length === 0) {
      return;
    }

    const info = await this.getTableInfo(request.schema, request.table, 'table');
    if (info.readOnly) {
      throw new Error(info.readOnlyReason ?? 'Table is read-only.');
    }

    const tableSql = quoteQualifiedIdentifier('mysql', request.schema, request.table);
    const connection = await this.pool.getConnection();

    try {
      await connection.beginTransaction();

      for (const key of request.keys) {
        const { whereSql, whereParams } = this.buildWhereFromRowKey(key);
        await connection.execute(`DELETE FROM ${tableSql} WHERE ${whereSql}`, whereParams);
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async getDdl(schema: string, objectName: string, objectType: 'table' | 'view'): Promise<string> {
    const qualified = quoteQualifiedIdentifier('mysql', schema, objectName);
    const sql = objectType === 'view' ? `SHOW CREATE VIEW ${qualified}` : `SHOW CREATE TABLE ${qualified}`;
    const [rows] = await this.pool.query<RowDataPacket[]>(sql);
    const firstRow = rows[0] as Record<string, unknown> | undefined;

    if (!firstRow) {
      throw new Error('DDL could not be loaded.');
    }

    const ddlField = objectType === 'view' ? 'Create View' : 'Create Table';
    const ddl = firstRow[ddlField] ?? firstRow[Object.keys(firstRow).find((key) => key.includes('Create')) ?? ''];

    if (typeof ddl !== 'string') {
      throw new Error('DDL could not be parsed from server response.');
    }

    return ddl;
  }

  async executeRaw(sql: string): Promise<RawQueryResult[]> {
    const started = Date.now();
    const [result, fields] = await this.pool.query(sql);
    const durationMs = Date.now() - started;
    return normalizeMysqlResult(result, fields, durationMs);
  }

  private async loadUniqueIndexCandidates(
    schema: string,
    table: string,
  ): Promise<UniqueIndexCandidate[]> {
    const [rows] = await this.pool.execute<RowDataPacket[]>(
      `
        SELECT
          s.INDEX_NAME,
          s.SEQ_IN_INDEX,
          s.COLUMN_NAME,
          c.IS_NULLABLE
        FROM information_schema.statistics s
        INNER JOIN information_schema.columns c
          ON c.TABLE_SCHEMA = s.TABLE_SCHEMA
         AND c.TABLE_NAME = s.TABLE_NAME
         AND c.COLUMN_NAME = s.COLUMN_NAME
        WHERE s.TABLE_SCHEMA = ?
          AND s.TABLE_NAME = ?
          AND s.NON_UNIQUE = 0
        ORDER BY s.INDEX_NAME ASC, s.SEQ_IN_INDEX ASC
      `,
      [schema, table],
    );

    const grouped = new Map<string, UniqueIndexCandidate>();

    for (const row of rows) {
      const indexName = String(row.INDEX_NAME);
      if (!grouped.has(indexName)) {
        grouped.set(indexName, { columns: [], nullable: false });
      }

      const candidate = grouped.get(indexName)!;
      candidate.columns.push(String(row.COLUMN_NAME));
      if (String(row.IS_NULLABLE) === 'YES') {
        candidate.nullable = true;
      }
    }

    return [...grouped.values()];
  }

  private rowPacketToRowData(row: RowDataPacket, tableInfo: TableInfo): RowData {
    const values: Record<string, ReturnType<typeof toScalar>> = {};

    for (const column of tableInfo.columns) {
      values[column.name] = toScalar(row[column.name]);
    }

    let key: RowKey | null = null;
    if (tableInfo.writableKey.kind === 'primary' || tableInfo.writableKey.kind === 'unique') {
      const keyValues: Record<string, ReturnType<typeof toScalar>> = {};
      for (const column of tableInfo.writableKey.columns) {
        keyValues[column] = toScalar(row[column]);
      }
      key = { kind: tableInfo.writableKey.kind, values: keyValues };
    }

    return { values, key };
  }

  private buildWhereFromRowKey(key: RowKey): { whereSql: string; whereParams: Scalar[] } {
    const entries = Object.entries(key.values);
    if (entries.length === 0) {
      throw new Error('Cannot modify row without a row key.');
    }

    const whereSql = entries.map(([column]) => `${quoteIdentifier('mysql', column)} = ?`).join(' AND ');
    return {
      whereSql,
      whereParams: entries.map(([, value]) => value),
    };
  }

}

function isResultSetHeader(value: unknown): value is ResultSetHeader {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'affectedRows' in (value as object);
}

function mysqlRowsToRaw(
  rows: RowDataPacket[],
  fields: FieldPacket[] | undefined,
  index: number,
  durationMs: number,
): RawQueryResult {
  const fieldColumns = (fields ?? []).map((field) => field.name);
  const columns = fieldColumns.length > 0 ? fieldColumns : rows[0] ? Object.keys(rows[0]) : [];
  const dataRows = rows.map((row) => columns.map((column) => toScalar((row as Record<string, unknown>)[column])));

  return {
    statementIndex: index,
    columns,
    rows: dataRows,
    rowCount: dataRows.length,
    durationMs,
  };
}

function mysqlHeaderToRaw(header: ResultSetHeader, index: number, durationMs: number): RawQueryResult {
  return {
    statementIndex: index,
    columns: [],
    rows: [],
    rowCount: 0,
    affectedRows: header.affectedRows,
    lastInsertId: header.insertId ?? undefined,
    durationMs,
  };
}

function normalizeMysqlResult(result: unknown, fields: unknown, durationMs: number): RawQueryResult[] {
  // Multiple statements: result is an array whose entries are each a row set or a header.
  if (Array.isArray(result) && result.length > 0 && (Array.isArray(result[0]) || isResultSetHeader(result[0]))) {
    const fieldGroups = Array.isArray(fields) ? (fields as (FieldPacket[] | undefined)[]) : [];
    return (result as unknown[]).map((part, index) =>
      Array.isArray(part)
        ? mysqlRowsToRaw(part as RowDataPacket[], fieldGroups[index], index, durationMs)
        : mysqlHeaderToRaw(part as ResultSetHeader, index, durationMs),
    );
  }

  // Single data/DDL statement.
  if (isResultSetHeader(result)) {
    return [mysqlHeaderToRaw(result, 0, durationMs)];
  }

  // Single row-producing statement (possibly zero rows, but fields are still present).
  if (Array.isArray(result)) {
    return [mysqlRowsToRaw(result as RowDataPacket[], fields as FieldPacket[] | undefined, 0, durationMs)];
  }

  return [];
}
