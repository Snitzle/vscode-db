import * as mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';
import type * as sqlite3 from 'sqlite3';
import { ConnectionInput } from '../types';
import { buildMySqlConnectionOptions, MySqlTarget } from './mysqlClient';
import { loadSqlite3 } from './sqlite3Loader';

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

/**
 * Try to connect with (possibly unsaved) form values and report the outcome.
 * `resolveStoredPassword` supplies the saved secret when the user is editing a
 * connection and left the password field blank ("keep existing").
 */
export async function testConnection(
  input: ConnectionInput,
  resolveStoredPassword: () => Promise<string | undefined>,
): Promise<TestConnectionResult> {
  try {
    if (input.type === 'sqlite') {
      const version = await testSqlite(input.filePath.trim());
      return { ok: true, message: `Connected — SQLite ${version}.` };
    }

    const password =
      typeof input.password === 'string' && input.password.length > 0
        ? input.password
        : input.id
          ? await resolveStoredPassword()
          : undefined;

    const version = await testMySql(input, password);
    return { ok: true, message: `Connected — MySQL server ${version}.` };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error.';
    return { ok: false, message };
  }
}

async function testMySql(input: MySqlTarget, password: string | undefined): Promise<string> {
  const connection = await mysql.createConnection({
    ...buildMySqlConnectionOptions(input, password),
    connectTimeout: 8000,
  });

  try {
    const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version');
    return String(rows[0]?.version ?? 'unknown version');
  } finally {
    await connection.end().catch(() => connection.destroy());
  }
}

async function testSqlite(filePath: string): Promise<string> {
  if (!filePath) {
    throw new Error('SQLite database file is required.');
  }

  const sqlite = loadSqlite3();
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const database = new sqlite.Database(filePath, sqlite.OPEN_READONLY, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    });
  });

  try {
    return await new Promise<string>((resolve, reject) => {
      db.get('SELECT sqlite_version() AS version', (error, row: { version?: string } | undefined) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(String(row?.version ?? 'unknown version'));
      });
    });
  } finally {
    db.close(() => undefined);
  }
}
