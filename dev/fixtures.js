// Fixture responder for the browser harness (see media/vscodeApi.js).
// Speaks the same message protocol as the extension host (src/webview/protocol.ts):
// each webview request maps to an array of extension events dispatched back.
// The table fixture is mutable, so edits/inserts/deletes behave like a live DB.
//
// Loaded before the webview bundle by dev/table.html and dev/explorer.html,
// which set window.__dbxSurface to 'table' or 'explorer'.
(() => {
  const FIRST = ['Ada', 'Grace', 'Alan', 'Edsger', 'Barbara', 'Donald', 'Margaret', 'Tony', 'Radia', 'Vint'];
  const LAST = ['Lovelace', 'Hopper', 'Turing', 'Dijkstra', 'Liskov', 'Knuth', 'Hamilton', 'Hoare', 'Perlman', 'Cerf'];
  const ROLES = ['Owner', 'Admin', 'Member', 'Viewer'];

  const columns = [
    { name: 'id', dataType: 'INTEGER', nullable: false, isPrimaryKey: true, isUniqueKey: true, isAutoIncrement: true },
    { name: 'name', dataType: 'TEXT', nullable: false, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'email', dataType: 'TEXT', nullable: true, isPrimaryKey: false, isUniqueKey: true, isAutoIncrement: false },
    { name: 'role', dataType: 'TEXT', nullable: false, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'active', dataType: 'tinyint(1)', nullable: false, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'score', dataType: 'double', nullable: true, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'payload', dataType: 'json', nullable: true, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'created_at', dataType: 'datetime', nullable: false, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
    { name: 'notes', dataType: 'TEXT', nullable: true, isPrimaryKey: false, isUniqueKey: false, isAutoIncrement: false },
  ];

  let nextId = 138;
  const rows = [];
  for (let i = 1; i <= 137; i += 1) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 3) % LAST.length];
    rows.push({
      id: i,
      name: `${first} ${last}`,
      email: i % 9 === 0 ? null : `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
      role: ROLES[i % ROLES.length],
      active: i % 3 === 0 ? 0 : 1,
      score: i % 7 === 0 ? null : Math.round(((i * 37) % 1000) + ((i * 13) % 10) * 0.1 * 10) / 10,
      payload:
        i % 11 === 0
          ? JSON.stringify({ plan: 'pro', flags: { beta: i % 2 === 0, seats: i % 20 }, tags: ['alpha', 'db'] })
          : null,
      created_at: `2026-0${(i % 6) + 1}-${String((i % 27) + 1).padStart(2, '0')} 0${i % 10}:${String((i * 7) % 60).padStart(2, '0')}:00`,
      notes: i % 5 === 0 ? `Imported batch ${Math.ceil(i / 20)} — needs review` : null,
    });
  }

  const tableInfo = () => ({
    schema: 'main',
    name: 'users',
    objectType: 'table',
    columns,
    writableKey: { kind: 'primary', columns: ['id'] },
    readOnly: false,
  });

  function toRowData(record) {
    return { key: { kind: 'primary', values: { id: record.id } }, values: { ...record } };
  }

  function compareValues(a, b) {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a).localeCompare(String(b));
  }

  function matchesFilter(record, filter) {
    const { column, operator, value } = filter;
    const v = record[column];
    switch (operator) {
      case 'eq': return String(v) === String(value);
      case 'neq': return String(v) !== String(value);
      case 'gt': return compareValues(v, value) > 0;
      case 'gte': return compareValues(v, value) >= 0;
      case 'lt': return compareValues(v, value) < 0;
      case 'lte': return compareValues(v, value) <= 0;
      case 'contains': return v !== null && String(v).toLowerCase().includes(String(value ?? '').toLowerCase());
      case 'startsWith': return v !== null && String(v).toLowerCase().startsWith(String(value ?? '').toLowerCase());
      case 'endsWith': return v !== null && String(v).toLowerCase().endsWith(String(value ?? '').toLowerCase());
      case 'isNull': return v === null || v === undefined;
      case 'isNotNull': return v !== null && v !== undefined;
      default: return true;
    }
  }

  function applyFilters(list, filters) {
    if (!Array.isArray(filters) || filters.length === 0) return list;
    return list.filter((record) => filters.every((filter) => matchesFilter(record, filter)));
  }

  function tableData(query = {}) {
    const page = Math.max(0, query.page || 0);
    const pageSize = Math.max(1, query.pageSize || 50);

    let filtered = applyFilters(rows.slice(), query.filters);
    if (query.where) {
      // The harness cannot evaluate raw SQL; it just narrates that it would.
      console.log(`[fixtures] raw WHERE ignored in harness: ${query.where}`);
    }

    const sort = Array.isArray(query.sort) ? query.sort : [];
    if (sort.length) {
      filtered.sort((a, b) => {
        for (const spec of sort) {
          const cmp = compareValues(a[spec.column], b[spec.column]);
          if (cmp !== 0) return spec.direction === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
    }

    return {
      kind: 'tableData',
      connectionId: 'fixture-conn',
      environment: 'prod',
      info: tableInfo(),
      rows: filtered.slice(page * pageSize, page * pageSize + pageSize).map(toRowData),
      page,
      pageSize,
      totalCount: filtered.length,
      sort: sort.length ? sort : undefined,
      filters: Array.isArray(query.filters) && query.filters.length ? query.filters : undefined,
      where: query.where,
    };
  }

  let lastQuery = {};

  function handleTableMessage(message) {
    switch (message.kind) {
      case 'ready':
      case 'refreshTable':
        return [tableData(lastQuery)];

      case 'queryTableRows':
        lastQuery = message;
        return [tableData(message)];

      case 'insertRow': {
        rows.push({ ...blankRecord(), ...message.payload.values, id: nextId++ });
        return [{ kind: 'mutationApplied', message: 'Row inserted.' }, tableData(lastQuery)];
      }

      case 'duplicateRow': {
        const source = message.row.values;
        rows.push({ ...blankRecord(), ...source, id: nextId++ });
        return [{ kind: 'mutationApplied', message: 'Row duplicated.' }, tableData(lastQuery)];
      }

      case 'updateRows': {
        for (const update of message.payload.updates) {
          const target = rows.find((record) => record.id === update.key.values.id);
          if (target) Object.assign(target, update.changes);
        }
        return [{ kind: 'mutationApplied', message: 'Changes applied.' }, tableData(lastQuery)];
      }

      case 'deleteRows': {
        const ids = new Set(message.payload.keys.map((key) => key.values.id));
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          if (ids.has(rows[i].id)) rows.splice(i, 1);
        }
        return [{ kind: 'mutationApplied', message: `${ids.size} row(s) deleted.` }, tableData(lastQuery)];
      }

      case 'viewDdl':
        return [{
          kind: 'ddl',
          connectionId: 'fixture-conn',
          schema: 'main',
          objectName: 'users',
          objectType: 'table',
          ddl: 'CREATE TABLE users (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  name TEXT NOT NULL,\n  email TEXT UNIQUE,\n  role TEXT NOT NULL DEFAULT \'Member\',\n  active TINYINT(1) NOT NULL DEFAULT 1,\n  score DOUBLE,\n  payload JSON,\n  created_at DATETIME NOT NULL,\n  notes TEXT\n)',
        }];

      case 'openDdlInEditor':
        return [{ kind: 'info', message: '[harness] Would open DDL in an editor tab.' }];

      case 'exportTable':
        return [{
          kind: 'info',
          message: `[harness] Would export (${message.selection.length} selected row(s) offered).`,
        }];

      default:
        return [{ kind: 'info', message: `[harness] Unhandled request: ${message.kind}` }];
    }
  }

  function blankRecord() {
    return { id: 0, name: '', email: null, role: 'Member', active: 1, score: null, payload: null, created_at: '2026-07-02 00:00:00', notes: null };
  }

  const connections = [
    { id: 'fixture-conn', name: 'Eventwise Mobile', type: 'sqlite', filePath: '/tmp/eventwise.sqlite', folderId: 'fixture-folder', environment: 'local' },
    { id: 'fixture-mysql', name: 'Production API', type: 'mysql', host: 'db.internal', port: 3306, user: 'app', database: 'api', environment: 'prod' },
    { id: 'fixture-staging', name: 'Staging DB', type: 'sqlite', filePath: '/tmp/staging.sqlite', folderId: 'fixture-folder', environment: 'staging' },
  ];

  const folders = [{ id: 'fixture-folder', name: 'Eventwise' }];
  let nextFolderNumber = 1;

  // Schema payloads applied to a node when its connection "connects".
  const fixtureSchemas = {
    'fixture-conn': [
      {
        name: 'main',
        objects: [
          { schema: 'main', name: 'accounts', type: 'table' },
          { schema: 'main', name: 'events', type: 'table' },
          { schema: 'main', name: 'jobs', type: 'table' },
          { schema: 'main', name: 'migrations', type: 'table' },
          { schema: 'main', name: 'users', type: 'table' },
          { schema: 'main', name: 'active_users', type: 'view' },
        ],
      },
    ],
    'fixture-staging': [
      {
        name: 'main',
        objects: [
          { schema: 'main', name: 'feature_flags', type: 'table' },
          { schema: 'main', name: 'sessions', type: 'table' },
        ],
      },
    ],
  };

  // Mutable so the reorder/connect handlers can reflect changes back to the
  // webview, mirroring how the host re-emits `state`.
  const treeNodes = [
    {
      connectionId: 'fixture-conn',
      connectionType: 'sqlite',
      name: 'Eventwise Mobile',
      folderId: 'fixture-folder',
      environment: 'local',
      status: 'connected',
      schemas: fixtureSchemas['fixture-conn'],
    },
    {
      connectionId: 'fixture-mysql',
      connectionType: 'mysql',
      name: 'Production API',
      environment: 'prod',
      status: 'disconnected',
      schemas: [],
    },
    {
      connectionId: 'fixture-staging',
      connectionType: 'sqlite',
      name: 'Staging DB',
      folderId: 'fixture-folder',
      environment: 'staging',
      status: 'disconnected',
      schemas: [],
    },
  ];

  function treeState() {
    return { kind: 'state', connections, tree: treeNodes, folders };
  }

  function handleExplorerMessage(message) {
    switch (message.kind) {
      case 'ready':
      case 'refreshTree':
        return [treeState()];

      case 'openTable':
        return [{ kind: 'info', message: `[harness] Would open ${message.schema}.${message.objectName} — see dev/table.html.` }];

      case 'selectConnectionForEdit': {
        const connection = connections.find((item) => item.id === message.connectionId);
        return connection
          ? [{ kind: 'connectionSelectedForEdit', connection }]
          : [{ kind: 'error', message: 'Connection not found.' }];
      }

      case 'pickSqliteFile':
        return [{ kind: 'sqliteFilePicked', filePath: '/tmp/sample.sqlite' }];

      case 'exportDatabase':
        return [{ kind: 'info', message: '[harness] Would export the database as a SQL dump.' }];

      case 'importSql':
        return [{ kind: 'info', message: '[harness] Would import a SQL file (host-side dialog).' }];

      case 'openQueryPanel':
        return [{ kind: 'info', message: '[harness] Would open a query panel — see dev/query.html.' }];

      case 'testConnection': {
        const conn = message.connection;
        if (conn.type === 'sqlite') {
          return conn.filePath
            ? [{ kind: 'testConnectionResult', ok: true, message: 'Connected — SQLite 3.45.1.' }]
            : [{ kind: 'testConnectionResult', ok: false, message: 'SQLite database file is required.' }];
        }
        return conn.host === 'db.internal'
          ? [{ kind: 'testConnectionResult', ok: false, message: 'MySQL connection refused. Check host, port, and network access.' }]
          : [{ kind: 'testConnectionResult', ok: true, message: 'Connected — MySQL server 8.4.0.' }];
      }

      case 'saveConnection':
        return [{ kind: 'info', message: `[harness] Connection "${message.connection.name}" saved (not persisted).` }, treeState()];

      case 'removeConnection':
        return [{ kind: 'info', message: '[harness] Connection removed (not persisted).' }, treeState()];

      case 'connectConnection': {
        const node = treeNodes.find((item) => item.connectionId === message.connectionId);
        if (!node) {
          return [{ kind: 'error', message: 'Connection not found.' }];
        }
        if (node.connectionId === 'fixture-mysql') {
          node.status = 'error';
          node.message = 'MySQL connection refused. Check host, port, and network access.';
        } else {
          node.status = 'connected';
          delete node.message;
          node.schemas = fixtureSchemas[node.connectionId] || [];
        }
        return [treeState()];
      }

      case 'disconnectConnection': {
        const node = treeNodes.find((item) => item.connectionId === message.connectionId);
        if (node) {
          node.status = 'disconnected';
          node.schemas = [];
          delete node.message;
        }
        return [treeState()];
      }

      case 'reorderConnections': {
        const rank = new Map(message.orderedIds.map((id, index) => [id, index]));
        const byRank = (getId) => (a, b) => (rank.get(getId(a)) ?? 0) - (rank.get(getId(b)) ?? 0);
        connections.sort(byRank((item) => item.id));
        treeNodes.sort(byRank((item) => item.connectionId));
        return [treeState()];
      }

      case 'moveConnection': {
        const rank = new Map(message.orderedIds.map((id, index) => [id, index]));
        const byRank = (getId) => (a, b) => (rank.get(getId(a)) ?? 0) - (rank.get(getId(b)) ?? 0);
        connections.sort(byRank((item) => item.id));
        treeNodes.sort(byRank((item) => item.connectionId));
        const folderId = message.folderId || undefined;
        for (const item of connections) {
          if (item.id === message.connectionId) item.folderId = folderId;
        }
        for (const node of treeNodes) {
          if (node.connectionId === message.connectionId) node.folderId = folderId;
        }
        return [treeState()];
      }

      case 'createFolder': {
        // The real host prompts for a name with a native input box.
        folders.push({ id: `fixture-folder-${nextFolderNumber}`, name: `New folder ${nextFolderNumber}` });
        nextFolderNumber += 1;
        return [{ kind: 'info', message: '[harness] Folder created (host would prompt for a name).' }, treeState()];
      }

      case 'renameFolder': {
        const folder = folders.find((item) => item.id === message.folderId);
        if (folder) folder.name = `${folder.name} (renamed)`;
        return [{ kind: 'info', message: '[harness] Folder renamed (host would prompt for a name).' }, treeState()];
      }

      case 'removeFolder': {
        const index = folders.findIndex((item) => item.id === message.folderId);
        if (index !== -1) folders.splice(index, 1);
        for (const item of connections) {
          if (item.folderId === message.folderId) delete item.folderId;
        }
        for (const node of treeNodes) {
          if (node.folderId === message.folderId) delete node.folderId;
        }
        return [{ kind: 'info', message: '[harness] Folder removed (host would confirm first).' }, treeState()];
      }

      case 'reorderFolders': {
        const rank = new Map(message.orderedIds.map((id, index) => [id, index]));
        folders.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
        return [treeState()];
      }

      default:
        return [{ kind: 'info', message: `[harness] Unhandled request: ${message.kind}` }];
    }
  }

  function handleQueryMessage(message) {
    switch (message.kind) {
      case 'ready':
        return [{ kind: 'queryConfig', connectionName: 'Eventwise Mobile', dialect: 'sqlite', environment: 'staging' }];

      case 'pickQueryHistory':
        return [
          { kind: 'info', message: '[harness] Host would show a QuickPick over query history.' },
          { kind: 'insertSql', sql: "select id, name, role from users where role = 'Owner' limit 10" },
        ];

      case 'runQuery': {
        const statements = message.sql
          .split(';')
          .map((part) => part.trim())
          .filter(Boolean);

        const results = statements.map((statement, index) => {
          if (/^(select|pragma|with|show|explain|values)\b/i.test(statement)) {
            const subset = rows.slice(0, 20);
            return {
              statementIndex: index,
              columns: ['id', 'name', 'email', 'role', 'score'],
              rows: subset.map((r) => [r.id, r.name, r.email, r.role, r.score]),
              rowCount: subset.length,
              durationMs: 3 + index,
            };
          }
          return {
            statementIndex: index,
            columns: [],
            rows: [],
            rowCount: 0,
            affectedRows: 3,
            lastInsertId: nextId,
            durationMs: 2 + index,
          };
        });

        // The host marks simple single-table SELECTs as editable; the harness
        // treats every row-producing fixture result as `main.users`.
        const editable = results.map((result) =>
          result.columns.length
            ? {
                schema: 'main',
                table: 'users',
                keyKind: 'primary',
                keyColumns: ['id'],
                columns: [
                  { name: 'id', editable: false, nullable: false, dataType: 'INTEGER' },
                  { name: 'name', editable: true, nullable: false, dataType: 'TEXT' },
                  { name: 'email', editable: true, nullable: true, dataType: 'TEXT' },
                  { name: 'role', editable: true, nullable: false, dataType: 'TEXT' },
                  { name: 'score', editable: true, nullable: true, dataType: 'double' },
                ],
              }
            : null,
        );

        return results.length
          ? [{ kind: 'queryResults', results, editable }]
          : [{ kind: 'error', message: 'Nothing to run.' }];
      }

      case 'updateQueryRows': {
        for (const update of message.payload.updates) {
          const target = rows.find((record) => record.id === update.key.values.id);
          if (target) Object.assign(target, update.changes);
        }
        return [{ kind: 'mutationApplied', message: 'Changes applied.' }];
      }

      case 'exportResults':
        return [{
          kind: 'info',
          message: `[harness] Would export result set ${message.statementIndex + 1} (host-side QuickPicks).`,
        }];

      default:
        return [{ kind: 'info', message: `[harness] Unhandled request: ${message.kind}` }];
    }
  }

  window.__dbxMockResponder = (message) => {
    if (window.__dbxSurface === 'explorer') return handleExplorerMessage(message);
    if (window.__dbxSurface === 'query') return handleQueryMessage(message);
    return handleTableMessage(message);
  };
})();
