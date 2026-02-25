import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import {
  ConnectionInput,
  ConnectionMeta,
  MySqlConnectionInput,
  MySqlConnectionMeta,
  SqliteConnectionInput,
  SqliteConnectionMeta,
} from '../types';

const CONNECTIONS_STATE_KEY = 'dbExplorer.connections';
const MYSQL_PASSWORD_SECRET_PREFIX = 'dbExplorer.mysql.password.';

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async listConnections(): Promise<ConnectionMeta[]> {
    const existing = this.context.globalState.get<ConnectionMeta[]>(CONNECTIONS_STATE_KEY);
    return Array.isArray(existing) ? existing : [];
  }

  async getConnection(connectionId: string): Promise<ConnectionMeta | undefined> {
    const items = await this.listConnections();
    return items.find((item) => item.id === connectionId);
  }

  async upsertConnection(input: ConnectionInput): Promise<ConnectionMeta> {
    if (input.type === 'mysql') {
      return this.upsertMySqlConnection(input);
    }

    return this.upsertSqliteConnection(input);
  }

  async removeConnection(connectionId: string): Promise<void> {
    const items = await this.listConnections();
    const next = items.filter((item) => item.id !== connectionId);
    await this.context.globalState.update(CONNECTIONS_STATE_KEY, next);
    await this.context.secrets.delete(this.passwordSecretKey(connectionId));
  }

  async getMySqlPassword(connectionId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.passwordSecretKey(connectionId));
  }

  private async upsertMySqlConnection(input: MySqlConnectionInput): Promise<MySqlConnectionMeta> {
    const items = await this.listConnections();
    const id = input.id ?? uuidv4();

    const meta: MySqlConnectionMeta = {
      id,
      type: 'mysql',
      name: input.name,
      host: input.host,
      port: input.port,
      user: input.user,
      database: input.database,
      ssl: input.ssl,
    };

    await this.updateConnectionList(items, meta);

    if (typeof input.password === 'string' && input.password.length > 0) {
      await this.context.secrets.store(this.passwordSecretKey(id), input.password);
    } else if (input.clearPassword) {
      await this.context.secrets.delete(this.passwordSecretKey(id));
    }

    return meta;
  }

  private async upsertSqliteConnection(input: SqliteConnectionInput): Promise<SqliteConnectionMeta> {
    const items = await this.listConnections();
    const id = input.id ?? uuidv4();

    const meta: SqliteConnectionMeta = {
      id,
      type: 'sqlite',
      name: input.name,
      filePath: input.filePath,
    };

    await this.updateConnectionList(items, meta);
    await this.context.secrets.delete(this.passwordSecretKey(id));
    return meta;
  }

  private async updateConnectionList(existing: ConnectionMeta[], nextConnection: ConnectionMeta): Promise<void> {
    const index = existing.findIndex((item) => item.id === nextConnection.id);
    const next = [...existing];

    if (index >= 0) {
      next[index] = nextConnection;
    } else {
      next.push(nextConnection);
    }

    await this.context.globalState.update(CONNECTIONS_STATE_KEY, next);
  }

  private passwordSecretKey(connectionId: string): string {
    return `${MYSQL_PASSWORD_SECRET_PREFIX}${connectionId}`;
  }
}
