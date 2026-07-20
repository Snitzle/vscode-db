import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2';
import { ConnectionInput } from '../types';
import { buildMySqlConnectionOptions, MySqlTarget } from './mysqlClient';
import { openSshTunnel, SshTunnel } from './sshTunnel';

export interface TestConnectionResult {
  ok: boolean;
  message: string;
}

/**
 * Try to connect with (possibly unsaved) form values and report the outcome.
 * The resolver callbacks supply saved secrets when the user is editing a
 * connection and left the password/passphrase fields blank ("keep existing").
 */
export async function testConnection(
  input: ConnectionInput,
  resolveStoredPassword: () => Promise<string | undefined>,
  resolveStoredSshSecret: () => Promise<string | undefined> = () => Promise.resolve(undefined),
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

    let tunnel: SshTunnel | undefined;
    let target: MySqlTarget = input;

    if (input.sshTunnel?.enabled) {
      const sshSecret =
        typeof input.sshPassword === 'string' && input.sshPassword.length > 0
          ? input.sshPassword
          : input.id
            ? await resolveStoredSshSecret()
            : undefined;
      tunnel = await openSshTunnel(input.sshTunnel, input.host, input.port, sshSecret);
      target = { ...input, host: '127.0.0.1', port: tunnel.localPort };
    }

    try {
      const version = await testMySql(target, password);
      return {
        ok: true,
        message: `Connected — MySQL server ${version}${tunnel ? ' (via SSH tunnel)' : ''}.`,
      };
    } finally {
      await tunnel?.dispose();
    }
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
  if (!fs.existsSync(filePath)) {
    throw new Error(`SQLite database file not found: ${filePath}`);
  }

  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT sqlite_version() AS version').get() as { version?: string } | undefined;
    return String(row?.version ?? 'unknown version');
  } finally {
    db.close();
  }
}
