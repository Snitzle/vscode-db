import { strict as assert } from 'assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteClient } from '../src/db/sqliteClient';
import { SqliteConnectionMeta } from '../src/types';

// True integration tests: with node:sqlite there is no native addon, so the
// real client runs directly under mocha against a temp database file.
describe('SqliteClient (node:sqlite)', () => {
  let dir: string;
  let filePath: string;
  let client: SqliteClient;

  const meta = (): SqliteConnectionMeta => ({ id: 'test', name: 'Test', type: 'sqlite', filePath });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openvsdb-test-'));
    filePath = path.join(dir, 'test.sqlite');
    fs.writeFileSync(filePath, '');

    client = await SqliteClient.create(meta());
    await client.executeRaw(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        active BOOLEAN NOT NULL DEFAULT 1,
        avatar BLOB
      );
      CREATE VIEW active_users AS SELECT * FROM users WHERE active = 1;
      INSERT INTO users (name, email) VALUES ('Ada', 'ada@example.com');
      INSERT INTO users (name, email) VALUES ('Grace', 'grace@example.com');
      INSERT INTO users (name, email, avatar) VALUES ('Alan', NULL, x'DEAD');
    `);
  });

  afterEach(async () => {
    await client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects a missing database file instead of creating one', async () => {
    await assert.rejects(
      SqliteClient.create({ id: 'x', name: 'x', type: 'sqlite', filePath: path.join(dir, 'missing.sqlite') }),
      /not found/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'missing.sqlite')), false);
  });

  it('lists schemas and objects', async () => {
    assert.deepEqual(await client.listSchemas(), ['main']);
    const objects = await client.listObjects('main');
    assert.deepEqual(
      objects.map((object) => `${object.type}:${object.name}`),
      ['table:users', 'view:active_users'],
    );
  });

  it('reads table info with keys and autoincrement', async () => {
    const info = await client.getTableInfo('main', 'users', 'table');
    assert.equal(info.readOnly, false);
    assert.deepEqual(info.writableKey, { kind: 'primary', columns: ['id'] });

    const id = info.columns.find((column) => column.name === 'id');
    assert.equal(id?.isPrimaryKey, true);
    assert.equal(id?.isAutoIncrement, true);

    const email = info.columns.find((column) => column.name === 'email');
    assert.equal(email?.isUniqueKey, true);
    assert.equal(email?.nullable, true);
  });

  it('pages rows with filters and a total count', async () => {
    const result = await client.queryTableRows(
      {
        schema: 'main',
        table: 'users',
        page: 0,
        pageSize: 2,
        filters: [{ column: 'name', operator: 'neq', value: 'Nobody' }],
        sort: [{ column: 'name', direction: 'asc' }],
        includeCount: true,
      },
      'table',
    );

    assert.equal(result.totalCount, 3);
    assert.deepEqual(
      result.rows.map((row) => row.values.name),
      ['Ada', 'Alan'],
    );
    assert.deepEqual(result.rows[0].key, { kind: 'primary', values: { id: 1 } });
  });

  it('renders BLOBs as hex', async () => {
    const result = await client.queryTableRows(
      { schema: 'main', table: 'users', page: 0, pageSize: 10 },
      'table',
    );
    const alan = result.rows.find((row) => row.values.name === 'Alan');
    assert.equal(alan?.values.avatar, '0xdead');
  });

  it('inserts, updates (with boolean coercion), and deletes through row keys', async () => {
    await client.insertRow({
      schema: 'main',
      table: 'users',
      values: { name: 'Radia', email: 'radia@example.com', active: false },
    });

    let result = await client.queryTableRows({ schema: 'main', table: 'users', page: 0, pageSize: 10 }, 'table');
    const radia = result.rows.find((row) => row.values.name === 'Radia');
    assert.ok(radia && radia.key);
    assert.equal(radia.values.active, 0);

    await client.updateRows({
      schema: 'main',
      table: 'users',
      updates: [{ key: radia.key!, changes: { name: 'Radia Perlman', active: true } }],
    });

    result = await client.queryTableRows({ schema: 'main', table: 'users', page: 0, pageSize: 10 }, 'table');
    const renamed = result.rows.find((row) => row.values.name === 'Radia Perlman');
    assert.ok(renamed);
    assert.equal(renamed.values.active, 1);

    await client.deleteRows({ schema: 'main', table: 'users', keys: [renamed.key!] });
    result = await client.queryTableRows(
      { schema: 'main', table: 'users', page: 0, pageSize: 10, includeCount: true },
      'table',
    );
    assert.equal(result.totalCount, 3);
  });

  it('executes raw multi-statement scripts with row and DML results', async () => {
    const results = await client.executeRaw(
      "INSERT INTO users (name) VALUES ('Vint'); SELECT name FROM users ORDER BY id",
    );

    assert.equal(results.length, 2);
    assert.equal(results[0].affectedRows, 1);
    assert.equal(typeof results[0].lastInsertId, 'number');
    assert.deepEqual(results[1].columns, ['name']);
    assert.equal(results[1].rowCount, 4);
  });

  it('treats views as read-only', async () => {
    const info = await client.getTableInfo('main', 'active_users', 'view');
    assert.equal(info.readOnly, true);
    assert.equal(info.writableKey.kind, 'none');
    // Writes are rejected even if something bypasses the UI's readOnly gate.
    await assert.rejects(
      client.insertRow({ schema: 'main', table: 'active_users', values: { name: 'x' } }),
      /view/i,
    );
  });

  it('returns DDL from sqlite_master', async () => {
    const ddl = await client.getDdl('main', 'users', 'table');
    assert.match(ddl, /CREATE TABLE users/);
    assert.match(ddl, /PRAGMA table_info/);
  });
});
