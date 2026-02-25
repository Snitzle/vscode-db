import * as fs from 'node:fs';
import * as mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';
import {
  ColumnInfo,
  DbObject,
  DeleteRowsRequest,
  InsertRowRequest,
  MySqlConnectionMeta,
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
import { buildOrderByClause, buildWhereClause } from '../sql/queryFragments';

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

export class MySqlClient implements DatabaseClient {
  public readonly dialect = 'mysql' as const;
  private readonly pool: mysql.Pool;

  constructor(private readonly connection: MySqlConnectionMeta, password: string | undefined) {
    this.pool = mysql.createPool({
      host: connection.host,
      port: connection.port,
      user: connection.user,
      password,
      database: connection.database,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      decimalNumbers: false,
      ssl: this.buildSslConfig(connection),
    });
  }

  async dispose(): Promise<void> {
    await this.pool.end();
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
    const where = buildWhereClause('mysql', query.filter, allowedColumns);
    const order = buildOrderByClause('mysql', query.sort, allowedColumns);

    const selectColumns = info.columns.map((column) => quoteIdentifier('mysql', column.name)).join(', ');
    const tableSql = quoteQualifiedIdentifier('mysql', query.schema, query.table);

    const sql = [
      `SELECT ${selectColumns} FROM ${tableSql}`,
      where.sql,
      order,
      'LIMIT ? OFFSET ?',
    ]
      .filter((part) => part.length > 0)
      .join(' ');

    const params = [...where.params, query.pageSize, query.page * query.pageSize];
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
      page: query.page,
      pageSize: query.pageSize,
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

  private buildSslConfig(connection: MySqlConnectionMeta): Record<string, unknown> | undefined {
    if (!connection.ssl?.enabled) {
      return undefined;
    }

    const sslOptions: Record<string, unknown> = {
      rejectUnauthorized: connection.ssl.rejectUnauthorized,
    };

    if (connection.ssl.caPath) {
      sslOptions.ca = fs.readFileSync(connection.ssl.caPath, 'utf8');
    }

    if (connection.ssl.certPath) {
      sslOptions.cert = fs.readFileSync(connection.ssl.certPath, 'utf8');
    }

    if (connection.ssl.keyPath) {
      sslOptions.key = fs.readFileSync(connection.ssl.keyPath, 'utf8');
    }

    if (connection.ssl.serverName) {
      sslOptions.servername = connection.ssl.serverName;
    }

    return sslOptions;
  }
}
