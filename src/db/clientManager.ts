import { DatabaseClient } from './client';
import { MySqlClient } from './mysqlClient';
import { openSshTunnel } from './sshTunnel';
import { SqliteClient } from './sqliteClient';
import { ConnectionStore } from '../state/connectionStore';
import { MySqlConnectionMeta } from '../types';

interface CachedClient {
  signature: string;
  client: DatabaseClient;
}

export class DbClientManager {
  private readonly cache = new Map<string, CachedClient>();

  constructor(private readonly connectionStore: ConnectionStore) {}

  /** Whether a client already exists — used to avoid connecting eagerly. */
  hasClient(connectionId: string): boolean {
    return this.cache.has(connectionId);
  }

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
        ? await this.createMySqlClient(connection)
        : await SqliteClient.create(connection);

    this.cache.set(connectionId, { signature, client });
    return client;
  }

  private async createMySqlClient(connection: MySqlConnectionMeta): Promise<DatabaseClient> {
    const password = await this.connectionStore.getMySqlPassword(connection.id);

    if (!connection.sshTunnel?.enabled) {
      return new MySqlClient(connection, password);
    }

    // The tunnel is opened first and torn down with the client: the pool
    // connects to the loopback forward instead of the real host.
    const tunnel = await openSshTunnel(
      connection.sshTunnel,
      connection.host,
      connection.port,
      await this.connectionStore.getSshSecret(connection.id),
    );

    return new MySqlClient(
      { ...connection, host: '127.0.0.1', port: tunnel.localPort },
      password,
      () => tunnel.dispose(),
    );
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
