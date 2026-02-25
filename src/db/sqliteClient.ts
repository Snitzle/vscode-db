import * as sqlite3 from 'sqlite3';
import {
  ColumnInfo,
  DbObject,
  DeleteRowsRequest,
  InsertRowRequest,
  RowData,
  RowKey,
  Scalar,
  SqliteConnectionMeta,
  TableInfo,
  TableQuery,
  TableQueryResult,
  UpdateRowsRequest,
} from '../types';
import { DatabaseClient } from './client';
import { chooseWritableKey, UniqueIndexCandidate } from './keyStrategy';
import { isLockedSqliteError, toScalar } from './valueCodec';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../sql/identifier';
import { buildOrderByClause, buildWhereClause } from '../sql/queryFragments';

const ROWID_ALIAS = '__dbx_rowid';

interface SqliteRunResult {
  lastID: number;
  changes: number;
}

interface SqliteTableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqliteIndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SqliteIndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

interface SqliteDatabaseListRow {
  seq: number;
  name: string;
  file: string;
}

export class SqliteClient implements DatabaseClient {
  public readonly dialect = 'sqlite' as const;
  private readonly db: sqlite3.Database;

  private constructor(private readonly connection: SqliteConnectionMeta, database: sqlite3.Database) {
    this.db = database;
  }

  static async create(connection: SqliteConnectionMeta): Promise<SqliteClient> {
    const database = await new Promise<sqlite3.Database>((resolve, reject) => {
      const db = new sqlite3.Database(connection.filePath, sqlite3.OPEN_READWRITE, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(db);
      });
    });

    return new SqliteClient(connection, database);
  }

  async dispose(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.db.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  async listSchemas(): Promise<string[]> {
    const rows = await this.all<SqliteDatabaseListRow>('PRAGMA database_list');
    return rows.map((row) => row.name);
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const schemaSql = quoteIdentifier('sqlite', schema);
    const sql = `
      SELECT name, type
      FROM ${schemaSql}.sqlite_master
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type ASC, name ASC
    `;

    const rows = await this.all<{ name: string; type: string }>(sql);

    return rows.map((row) => ({
      schema,
      name: row.name,
      type: row.type === 'view' ? 'view' : 'table',
    }));
  }

  async getTableInfo(schema: string, name: string, objectType: 'table' | 'view'): Promise<TableInfo> {
    const tableRows = await this.getPragmaTableInfo(schema, name);
    const uniqueCandidates = await this.loadUniqueIndexCandidates(schema, name, tableRows);

    const primaryKeyColumns = tableRows
      .filter((row) => row.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);

    const createSqlRow = await this.get<{ sql: string | null }>(
      `SELECT sql FROM ${quoteIdentifier('sqlite', schema)}.sqlite_master WHERE type = ? AND name = ?`,
      [objectType, name],
    );

    const createSql = createSqlRow?.sql ?? '';
    const allowRowId =
      objectType === 'table' && createSql.toUpperCase().includes('WITHOUT ROWID') === false;

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
            allowRowId,
          });

    const uniqueColumns = new Set(uniqueCandidates.flatMap((candidate) => candidate.columns));
    const hasAutoincrement = createSql.toUpperCase().includes('AUTOINCREMENT');

    const columns: ColumnInfo[] = tableRows.map((row) => ({
      name: row.name,
      dataType: row.type,
      nullable: row.notnull === 0,
      isPrimaryKey: row.pk > 0,
      isUniqueKey: uniqueColumns.has(row.name),
      isAutoIncrement: hasAutoincrement && row.pk > 0,
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
    const where = buildWhereClause('sqlite', query.filter, allowedColumns);
    const order = buildOrderByClause('sqlite', query.sort, allowedColumns);

    const columnSql = info.columns.map((column) => quoteIdentifier('sqlite', column.name));
    if (info.writableKey.kind === 'rowid') {
      columnSql.push(`rowid AS ${quoteIdentifier('sqlite', ROWID_ALIAS)}`);
    }

    const tableSql = quoteQualifiedIdentifier('sqlite', query.schema, query.table);
    const sql = [
      `SELECT ${columnSql.join(', ')} FROM ${tableSql}`,
      where.sql,
      order,
      'LIMIT ? OFFSET ?',
    ]
      .filter((part) => part.length > 0)
      .join(' ');

    const params = [...where.params, query.pageSize, query.page * query.pageSize];
    const rows = await this.withRetry(() => this.all<Record<string, unknown>>(sql, params), 'reading rows');

    const dataRows: RowData[] = rows.map((row) => this.sqliteRowToRowData(row, info));

    let totalCount: number | undefined;
    if (query.includeCount) {
      const countSql = [`SELECT COUNT(*) AS totalCount FROM ${tableSql}`, where.sql]
        .filter((part) => part.length > 0)
        .join(' ');
      const countRow = await this.withRetry(
        () => this.get<{ totalCount: number }>(countSql, where.params),
        'counting rows',
      );
      totalCount = Number(countRow?.totalCount ?? 0);
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

    const writableColumns = new Set(
      info.columns.filter((column) => !column.isAutoIncrement).map((column) => column.name),
    );
    const entries = Object.entries(request.values).filter(([column]) => writableColumns.has(column));

    const tableSql = quoteQualifiedIdentifier('sqlite', request.schema, request.table);

    await this.withRetry(async () => {
      if (entries.length === 0) {
        await this.run(`INSERT INTO ${tableSql} DEFAULT VALUES`);
        return;
      }

      const columnSql = entries.map(([column]) => quoteIdentifier('sqlite', column)).join(', ');
      const placeholders = entries.map(() => '?').join(', ');
      const params = entries.map(([, value]) => value);

      await this.run(`INSERT INTO ${tableSql} (${columnSql}) VALUES (${placeholders})`, params);
    }, 'inserting row');
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

    const tableSql = quoteQualifiedIdentifier('sqlite', request.schema, request.table);

    await this.withRetry(async () => {
      await this.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        for (const update of request.updates) {
          const entries = Object.entries(update.changes).filter(([column]) => editableColumns.has(column));
          if (entries.length === 0) {
            continue;
          }

          const setSql = entries.map(([column]) => `${quoteIdentifier('sqlite', column)} = ?`).join(', ');
          const { whereSql, whereParams } = this.buildWhereFromRowKey(update.key);
          const params = [...entries.map(([, value]) => value), ...whereParams];

          await this.run(`UPDATE ${tableSql} SET ${setSql} WHERE ${whereSql}`, params);
        }
        await this.exec('COMMIT');
      } catch (error) {
        await this.exec('ROLLBACK');
        throw error;
      }
    }, 'updating rows');
  }

  async deleteRows(request: DeleteRowsRequest): Promise<void> {
    if (request.keys.length === 0) {
      return;
    }

    const info = await this.getTableInfo(request.schema, request.table, 'table');
    if (info.readOnly) {
      throw new Error(info.readOnlyReason ?? 'Table is read-only.');
    }

    const tableSql = quoteQualifiedIdentifier('sqlite', request.schema, request.table);

    await this.withRetry(async () => {
      await this.exec('BEGIN IMMEDIATE TRANSACTION');
      try {
        for (const key of request.keys) {
          const { whereSql, whereParams } = this.buildWhereFromRowKey(key);
          await this.run(`DELETE FROM ${tableSql} WHERE ${whereSql}`, whereParams);
        }
        await this.exec('COMMIT');
      } catch (error) {
        await this.exec('ROLLBACK');
        throw error;
      }
    }, 'deleting rows');
  }

  async getDdl(schema: string, objectName: string, objectType: 'table' | 'view'): Promise<string> {
    const masterSql = `SELECT sql FROM ${quoteIdentifier('sqlite', schema)}.sqlite_master WHERE type = ? AND name = ?`;
    const row = await this.get<{ sql: string | null }>(masterSql, [objectType, objectName]);
    let ddl = row?.sql ?? '-- DDL not found in sqlite_master.';

    if (objectType === 'table') {
      const tableInfoRows = await this.getPragmaTableInfo(schema, objectName);
      const fkRows = await this.all<Record<string, unknown>>(
        `PRAGMA ${quoteIdentifier('sqlite', schema)}.foreign_key_list(${toSqliteStringLiteral(objectName)})`,
      );

      const tableInfoSection = tableInfoRows
        .map(
          (item) =>
            `-- ${item.cid}: ${item.name} ${item.type} notnull=${item.notnull} pk=${item.pk} default=${String(item.dflt_value)}`,
        )
        .join('\n');
      const fkSection = fkRows
        .map((item) => `-- ${JSON.stringify(item)}`)
        .join('\n');

      ddl = `${ddl}\n\n-- PRAGMA table_info\n${tableInfoSection || '-- none'}`;
      ddl = `${ddl}\n\n-- PRAGMA foreign_key_list\n${fkSection || '-- none'}`;
    }

    return ddl;
  }

  private async getPragmaTableInfo(schema: string, table: string): Promise<SqliteTableInfoRow[]> {
    return this.all<SqliteTableInfoRow>(
      `PRAGMA ${quoteIdentifier('sqlite', schema)}.table_info(${toSqliteStringLiteral(table)})`,
    );
  }

  private async loadUniqueIndexCandidates(
    schema: string,
    table: string,
    tableInfoRows: SqliteTableInfoRow[],
  ): Promise<UniqueIndexCandidate[]> {
    const listRows = await this.all<SqliteIndexListRow>(
      `PRAGMA ${quoteIdentifier('sqlite', schema)}.index_list(${toSqliteStringLiteral(table)})`,
    );

    const nullableByColumn = new Map(tableInfoRows.map((row) => [row.name, row.notnull === 0]));
    const uniqueCandidates: UniqueIndexCandidate[] = [];

    for (const row of listRows) {
      if (row.unique !== 1 || row.partial === 1) {
        continue;
      }

      const indexRows = await this.all<SqliteIndexInfoRow>(
        `PRAGMA ${quoteIdentifier('sqlite', schema)}.index_info(${toSqliteStringLiteral(row.name)})`,
      );

      const columns = indexRows
        .sort((a, b) => a.seqno - b.seqno)
        .map((entry) => entry.name)
        .filter((column): column is string => Boolean(column));

      if (columns.length === 0) {
        continue;
      }

      const nullable = columns.some((column) => nullableByColumn.get(column) !== false);
      uniqueCandidates.push({ columns, nullable });
    }

    return uniqueCandidates;
  }

  private sqliteRowToRowData(row: Record<string, unknown>, tableInfo: TableInfo): RowData {
    const values: Record<string, Scalar> = {};
    for (const column of tableInfo.columns) {
      values[column.name] = toScalar(row[column.name]);
    }

    let key: RowKey | null = null;
    if (tableInfo.writableKey.kind === 'rowid') {
      key = {
        kind: 'rowid',
        values: { rowid: toScalar(row[ROWID_ALIAS]) },
      };
    } else if (tableInfo.writableKey.kind === 'primary' || tableInfo.writableKey.kind === 'unique') {
      const keyValues: Record<string, Scalar> = {};
      for (const column of tableInfo.writableKey.columns) {
        keyValues[column] = toScalar(row[column]);
      }
      key = { kind: tableInfo.writableKey.kind, values: keyValues };
    }

    return { values, key };
  }

  private buildWhereFromRowKey(key: RowKey): { whereSql: string; whereParams: Scalar[] } {
    if (key.kind === 'rowid') {
      return { whereSql: 'rowid = ?', whereParams: [key.values.rowid ?? null] };
    }

    const entries = Object.entries(key.values);
    if (entries.length === 0) {
      throw new Error('Cannot modify row without a row key.');
    }

    const whereSql = entries.map(([column]) => `${quoteIdentifier('sqlite', column)} = ?`).join(' AND ');
    return {
      whereSql,
      whereParams: entries.map(([, value]) => value ?? null),
    };
  }

  private async withRetry<T>(operation: () => Promise<T>, actionName: string): Promise<T> {
    const maxAttempts = 5;
    let delayMs = 50;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (!isLockedSqliteError(error) || attempt === maxAttempts) {
          if (isLockedSqliteError(error)) {
            throw new Error(
              `SQLite database is locked after ${maxAttempts} attempts while ${actionName}. Close other writers and retry.`,
            );
          }
          throw error;
        }

        await sleep(delayMs);
        delayMs *= 2;
      }
    }

    throw new Error('Unexpected retry flow.');
  }

  private async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise<T[]>((resolve, reject) => {
      this.db.all(sql, params, (error, rows) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(rows as T[]);
      });
    });
  }

  private async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      this.db.get(sql, params, (error, row) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(row as T | undefined);
      });
    });
  }

  private async run(sql: string, params: unknown[] = []): Promise<SqliteRunResult> {
    return new Promise<SqliteRunResult>((resolve, reject) => {
      this.db.run(sql, params, function onRun(error: Error | null) {
        if (error) {
          reject(error);
          return;
        }

        resolve({
          lastID: this.lastID,
          changes: this.changes,
        });
      });
    });
  }

  private async exec(sql: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.db.exec(sql, (error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
}

function toSqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
