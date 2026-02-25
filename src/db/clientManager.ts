import { DatabaseClient } from './client';
import { MySqlClient } from './mysqlClient';
import { SqliteClient } from './sqliteClient';
import { ConnectionStore } from '../state/connectionStore';

interface CachedClient {
  signature: string;
  client: DatabaseClient;
}

export class DbClientManager {
  private readonly cache = new Map<string, CachedClient>();

  constructor(private readonly connectionStore: ConnectionStore) {}

  async getClient(connectionId: string): Promise<DatabaseClient> {
    const connection = await this.connectionStore.getConnection(connectionId);
    if (!connection) {
      throw new Error('Connection not found.');
    }

    const signature = JSON.stringify(connection);
    const existing = this.cache.get(connectionId);

    if (existing && existing.signature === signature) {
      return existing.client;
    }

    if (existing) {
      await existing.client.dispose();
      this.cache.delete(connectionId);
    }

    const client =
      connection.type === 'mysql'
        ? new MySqlClient(connection, await this.connectionStore.getMySqlPassword(connection.id))
        : await SqliteClient.create(connection);

    this.cache.set(connectionId, { signature, client });
    return client;
  }

  async invalidate(connectionId: string): Promise<void> {
    const cached = this.cache.get(connectionId);
    if (!cached) {
      return;
    }

    await cached.client.dispose();
    this.cache.delete(connectionId);
  }

  async disposeAll(): Promise<void> {
    const disposals = [...this.cache.values()].map((item) => item.client.dispose());
    await Promise.allSettled(disposals);
    this.cache.clear();
  }
}
