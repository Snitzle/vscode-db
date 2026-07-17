import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';
import {
  ConnectionInput,
  ConnectionMeta,
  FolderMeta,
  MySqlConnectionInput,
  MySqlConnectionMeta,
  SqliteConnectionInput,
  SqliteConnectionMeta,
} from '../types';

const CONNECTIONS_STATE_KEY = 'dbExplorer.connections';
const FOLDERS_STATE_KEY = 'dbExplorer.folders';
const MYSQL_PASSWORD_SECRET_PREFIX = 'dbExplorer.mysql.password.';
const SSH_SECRET_PREFIX = 'dbExplorer.ssh.secret.';

export class ConnectionStore {
  constructor(private readonly context: vscode.ExtensionContext) {
    // Connections and folders roam across machines via Settings Sync.
    // Passwords and SSH secrets deliberately stay in local SecretStorage —
    // secrets never sync, so a synced connection prompts again elsewhere.
    context.globalState.setKeysForSync([CONNECTIONS_STATE_KEY, FOLDERS_STATE_KEY]);
  }

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
    await this.context.secrets.delete(this.sshSecretKey(connectionId));
  }

  /**
   * Persist a new connection order. `orderedIds` comes from the sidebar's
   * drag-and-drop; {@link applyOrder} tolerates a stale list (ids added or
   * removed in another window between the drag starting and the drop).
   */
  async reorderConnections(orderedIds: string[]): Promise<void> {
    const items = await this.listConnections();
    const next = applyOrder(items, orderedIds);
    await this.context.globalState.update(CONNECTIONS_STATE_KEY, next);
  }

  /**
   * Move a connection into a folder (or to the top level with `null`) and
   * apply the new global order in one write, so a drag that changes both
   * cannot be observed half-applied.
   */
  async moveConnection(connectionId: string, folderId: string | null, orderedIds: string[]): Promise<void> {
    const items = await this.listConnections();
    const next = applyMove(items, connectionId, folderId, orderedIds);
    await this.context.globalState.update(CONNECTIONS_STATE_KEY, next);
  }

  async listFolders(): Promise<FolderMeta[]> {
    const existing = this.context.globalState.get<FolderMeta[]>(FOLDERS_STATE_KEY);
    return Array.isArray(existing) ? existing : [];
  }

  async getFolder(folderId: string): Promise<FolderMeta | undefined> {
    const folders = await this.listFolders();
    return folders.find((folder) => folder.id === folderId);
  }

  async createFolder(name: string): Promise<FolderMeta> {
    const folders = await this.listFolders();
    const folder: FolderMeta = { id: uuidv4(), name };
    await this.context.globalState.update(FOLDERS_STATE_KEY, [...folders, folder]);
    return folder;
  }

  async renameFolder(folderId: string, name: string): Promise<void> {
    const folders = await this.listFolders();
    const next = folders.map((folder) => (folder.id === folderId ? { ...folder, name } : folder));
    await this.context.globalState.update(FOLDERS_STATE_KEY, next);
  }

  /** Delete a folder; its connections move back to the top level. */
  async removeFolder(folderId: string): Promise<void> {
    const folders = await this.listFolders();
    await this.context.globalState.update(
      FOLDERS_STATE_KEY,
      folders.filter((folder) => folder.id !== folderId),
    );

    const items = await this.listConnections();
    const next = items.map((item) => (item.folderId === folderId ? { ...item, folderId: undefined } : item));
    await this.context.globalState.update(CONNECTIONS_STATE_KEY, next);
  }

  async reorderFolders(orderedIds: string[]): Promise<void> {
    const folders = await this.listFolders();
    await this.context.globalState.update(FOLDERS_STATE_KEY, applyOrder(folders, orderedIds));
  }

  async getMySqlPassword(connectionId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.passwordSecretKey(connectionId));
  }

  /** SSH password or key passphrase for a connection's tunnel. */
  async getSshSecret(connectionId: string): Promise<string | undefined> {
    return this.context.secrets.get(this.sshSecretKey(connectionId));
  }

  private async upsertMySqlConnection(input: MySqlConnectionInput): Promise<MySqlConnectionMeta> {
    const items = await this.listConnections();
    const id = input.id ?? uuidv4();

    const meta: MySqlConnectionMeta = {
      id,
      type: 'mysql',
      name: input.name,
      // Editing a connection must not eject it from its folder.
      folderId: items.find((item) => item.id === id)?.folderId,
      environment: input.environment,
      host: input.host,
      port: input.port,
      user: input.user,
      database: input.database,
      ssl: input.ssl,
      allowClearTextAuth: input.allowClearTextAuth,
      sshTunnel: input.sshTunnel,
    };

    await this.updateConnectionList(items, meta);

    if (typeof input.password === 'string' && input.password.length > 0) {
      await this.context.secrets.store(this.passwordSecretKey(id), input.password);
    } else if (input.clearPassword) {
      await this.context.secrets.delete(this.passwordSecretKey(id));
    }

    if (typeof input.sshPassword === 'string' && input.sshPassword.length > 0) {
      await this.context.secrets.store(this.sshSecretKey(id), input.sshPassword);
    } else if (input.clearSshPassword) {
      await this.context.secrets.delete(this.sshSecretKey(id));
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
      folderId: items.find((item) => item.id === id)?.folderId,
      environment: input.environment,
      filePath: input.filePath,
    };

    await this.updateConnectionList(items, meta);
    await this.context.secrets.delete(this.passwordSecretKey(id));
    await this.context.secrets.delete(this.sshSecretKey(id));
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

  private sshSecretKey(connectionId: string): string {
    return `${SSH_SECRET_PREFIX}${connectionId}`;
  }
}

/**
 * Returns `items` reordered to match `orderedIds`. Ids in `orderedIds` that are
 * absent from `items` are ignored; items whose id is absent from `orderedIds`
 * keep their original relative order at the end. Pure, so it is unit-tested
 * directly.
 */
export function applyOrder<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: T[] = [];

  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      byId.delete(id);
    }
  }

  // Preserve original order for anything the caller didn't mention.
  for (const item of items) {
    if (byId.has(item.id)) {
      ordered.push(item);
    }
  }

  return ordered;
}

/**
 * {@link applyOrder} plus a folder assignment for the moved item — the list
 * transform behind {@link ConnectionStore.moveConnection}. Pure, so it is
 * unit-tested directly. A `folderId` of `null` moves the item to the top level.
 */
export function applyMove<T extends { id: string; folderId?: string }>(
  items: T[],
  movedId: string,
  folderId: string | null,
  orderedIds: string[],
): T[] {
  return applyOrder(items, orderedIds).map((item) =>
    item.id === movedId ? { ...item, folderId: folderId ?? undefined } : item,
  );
}
