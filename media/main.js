(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    connections: [],
    tree: [],
    selectedObject: null,
    connectionForm: {
      visible: false,
      mode: 'add',
      editingId: undefined,
    },
  };

  let requestCounter = 0;

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="root">
      <section class="panel" id="connectionFormPanel" hidden>
        <div class="panelHeader">
          <h2 id="connectionFormTitle">Add Connection</h2>
          <button id="btnCancelConnectionForm" class="secondary">Close</button>
        </div>

        <form id="connectionForm">
          <div class="formGrid">
            <label>Type
              <select id="connectionType">
                <option value="sqlite">SQLite</option>
                <option value="mysql">MySQL</option>
              </select>
            </label>
            <label>Name
              <input id="connectionName" required />
            </label>
          </div>

          <div id="sqliteFields">
            <label>SQLite File
              <div class="inlineInput">
                <input id="sqliteFilePath" placeholder="/path/to/database.sqlite" />
                <button type="button" id="btnBrowseSqlite" class="secondary">Browse</button>
              </div>
            </label>
          </div>

          <div id="mysqlFields" hidden>
            <div class="formGrid">
              <label>Host
                <input id="mysqlHost" placeholder="127.0.0.1" />
              </label>
              <label>Port
                <input id="mysqlPort" type="number" min="1" max="65535" value="3306" />
              </label>
              <label>User
                <input id="mysqlUser" placeholder="root" />
              </label>
              <label>Password
                <input id="mysqlPassword" type="password" autocomplete="off" />
              </label>
              <label>Database
                <input id="mysqlDatabase" placeholder="app_db" />
              </label>
            </div>

            <details>
              <summary>SSL (optional)</summary>
              <div class="formGrid">
                <label class="checkboxField">
                  <input id="mysqlSslEnabled" type="checkbox" /> Enable SSL
                </label>
                <label class="checkboxField">
                  <input id="mysqlSslRejectUnauthorized" type="checkbox" checked /> Reject Unauthorized
                </label>
                <label>CA path
                  <input id="mysqlSslCaPath" placeholder="/path/to/ca.pem" />
                </label>
                <label>Cert path
                  <input id="mysqlSslCertPath" placeholder="/path/to/client-cert.pem" />
                </label>
                <label>Key path
                  <input id="mysqlSslKeyPath" placeholder="/path/to/client-key.pem" />
                </label>
                <label>Server Name
                  <input id="mysqlSslServerName" placeholder="db.example.com" />
                </label>
              </div>
            </details>
            <label class="checkboxField" id="clearPasswordWrap" hidden>
              <input id="mysqlClearPassword" type="checkbox" /> Clear stored password
            </label>
          </div>

          <div class="actions">
            <button type="submit" id="btnSaveConnection">Save Connection</button>
          </div>
        </form>
      </section>

      <section class="panel">
        <div class="panelHeader">
          <h2>Connections</h2>
        </div>
        <div id="connectionTree" class="tree"></div>
      </section>

      <div id="statusBar" class="status"></div>
    </div>
  `;

  const elements = {
    connectionFormPanel: document.getElementById('connectionFormPanel'),
    connectionFormTitle: document.getElementById('connectionFormTitle'),
    btnCancelConnectionForm: document.getElementById('btnCancelConnectionForm'),
    connectionForm: document.getElementById('connectionForm'),
    connectionType: document.getElementById('connectionType'),
    connectionName: document.getElementById('connectionName'),
    sqliteFields: document.getElementById('sqliteFields'),
    sqliteFilePath: document.getElementById('sqliteFilePath'),
    btnBrowseSqlite: document.getElementById('btnBrowseSqlite'),
    mysqlFields: document.getElementById('mysqlFields'),
    mysqlHost: document.getElementById('mysqlHost'),
    mysqlPort: document.getElementById('mysqlPort'),
    mysqlUser: document.getElementById('mysqlUser'),
    mysqlPassword: document.getElementById('mysqlPassword'),
    mysqlDatabase: document.getElementById('mysqlDatabase'),
    mysqlSslEnabled: document.getElementById('mysqlSslEnabled'),
    mysqlSslRejectUnauthorized: document.getElementById('mysqlSslRejectUnauthorized'),
    mysqlSslCaPath: document.getElementById('mysqlSslCaPath'),
    mysqlSslCertPath: document.getElementById('mysqlSslCertPath'),
    mysqlSslKeyPath: document.getElementById('mysqlSslKeyPath'),
    mysqlSslServerName: document.getElementById('mysqlSslServerName'),
    clearPasswordWrap: document.getElementById('clearPasswordWrap'),
    mysqlClearPassword: document.getElementById('mysqlClearPassword'),
    connectionTree: document.getElementById('connectionTree'),
    statusBar: document.getElementById('statusBar'),
  };

  elements.btnCancelConnectionForm.addEventListener('click', () => hideConnectionForm());
  elements.connectionType.addEventListener('change', updateConnectionTypeFields);
  elements.btnBrowseSqlite.addEventListener('click', () => sendRequest('pickSqliteFile'));

  elements.connectionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveConnectionFromForm();
  });

  window.addEventListener('message', (event) => {
    handleEvent(event.data);
  });

  sendRequest('ready');

  function handleEvent(message) {
    switch (message.kind) {
      case 'state':
        state.tree = message.tree;
        state.connections = message.connections;
        renderConnectionTree();
        break;

      case 'sqliteFilePicked':
        if (message.filePath) {
          elements.sqliteFilePath.value = message.filePath;
        }
        break;

      case 'triggerAddConnection':
        openConnectionForm('add');
        break;

      case 'connectionSelectedForEdit':
        openConnectionForm('edit', message.connection);
        break;

      case 'info':
        showStatus(message.message);
        break;

      case 'error':
        showStatus(message.message, true);
        if (message.details) {
          console.error(message.details);
        }
        break;

      default:
        break;
    }
  }

  function sendRequest(kind, payload = {}) {
    requestCounter += 1;
    const requestId = `r${Date.now()}_${requestCounter}`;
    vscode.postMessage({ kind, requestId, ...payload });
  }

  function openConnectionForm(mode, connection) {
    state.connectionForm.visible = true;
    state.connectionForm.mode = mode;
    state.connectionForm.editingId = connection ? connection.id : undefined;

    elements.connectionFormTitle.textContent = mode === 'add' ? 'Add Connection' : 'Edit Connection';
    elements.connectionFormPanel.hidden = false;
    elements.clearPasswordWrap.hidden = mode !== 'edit';

    if (!connection) {
      elements.connectionType.value = 'sqlite';
      elements.connectionName.value = '';
      elements.sqliteFilePath.value = '';
      elements.mysqlHost.value = '127.0.0.1';
      elements.mysqlPort.value = '3306';
      elements.mysqlUser.value = '';
      elements.mysqlPassword.value = '';
      elements.mysqlDatabase.value = '';
      elements.mysqlSslEnabled.checked = false;
      elements.mysqlSslRejectUnauthorized.checked = true;
      elements.mysqlSslCaPath.value = '';
      elements.mysqlSslCertPath.value = '';
      elements.mysqlSslKeyPath.value = '';
      elements.mysqlSslServerName.value = '';
      elements.mysqlClearPassword.checked = false;
      updateConnectionTypeFields();
      return;
    }

    elements.connectionType.value = connection.type;
    elements.connectionName.value = connection.name;

    if (connection.type === 'sqlite') {
      elements.sqliteFilePath.value = connection.filePath;
    } else {
      elements.mysqlHost.value = connection.host;
      elements.mysqlPort.value = String(connection.port);
      elements.mysqlUser.value = connection.user;
      elements.mysqlPassword.value = '';
      elements.mysqlDatabase.value = connection.database;
      elements.mysqlSslEnabled.checked = Boolean(connection.ssl && connection.ssl.enabled);
      elements.mysqlSslRejectUnauthorized.checked =
        connection.ssl && connection.ssl.rejectUnauthorized !== undefined
          ? Boolean(connection.ssl.rejectUnauthorized)
          : true;
      elements.mysqlSslCaPath.value = connection.ssl && connection.ssl.caPath ? connection.ssl.caPath : '';
      elements.mysqlSslCertPath.value =
        connection.ssl && connection.ssl.certPath ? connection.ssl.certPath : '';
      elements.mysqlSslKeyPath.value = connection.ssl && connection.ssl.keyPath ? connection.ssl.keyPath : '';
      elements.mysqlSslServerName.value =
        connection.ssl && connection.ssl.serverName ? connection.ssl.serverName : '';
      elements.mysqlClearPassword.checked = false;
    }

    updateConnectionTypeFields();
  }

  function hideConnectionForm() {
    state.connectionForm.visible = false;
    state.connectionForm.editingId = undefined;
    elements.connectionFormPanel.hidden = true;
  }

  function updateConnectionTypeFields() {
    const isSqlite = elements.connectionType.value === 'sqlite';
    elements.sqliteFields.hidden = !isSqlite;
    elements.mysqlFields.hidden = isSqlite;
  }

  function saveConnectionFromForm() {
    const type = elements.connectionType.value;
    const mode = state.connectionForm.mode;

    if (type === 'sqlite') {
      sendRequest('saveConnection', {
        mode,
        connection: {
          id: state.connectionForm.editingId,
          type: 'sqlite',
          name: elements.connectionName.value.trim(),
          filePath: elements.sqliteFilePath.value.trim(),
        },
      });
      hideConnectionForm();
      return;
    }

    const sslEnabled = elements.mysqlSslEnabled.checked;
    sendRequest('saveConnection', {
      mode,
      connection: {
        id: state.connectionForm.editingId,
        type: 'mysql',
        name: elements.connectionName.value.trim(),
        host: elements.mysqlHost.value.trim(),
        port: Number(elements.mysqlPort.value || 3306),
        user: elements.mysqlUser.value.trim(),
        password: elements.mysqlPassword.value,
        clearPassword: elements.mysqlClearPassword.checked,
        database: elements.mysqlDatabase.value.trim(),
        ssl: sslEnabled
          ? {
              enabled: true,
              rejectUnauthorized: elements.mysqlSslRejectUnauthorized.checked,
              caPath: normalizeOptional(elements.mysqlSslCaPath.value),
              certPath: normalizeOptional(elements.mysqlSslCertPath.value),
              keyPath: normalizeOptional(elements.mysqlSslKeyPath.value),
              serverName: normalizeOptional(elements.mysqlSslServerName.value),
            }
          : {
              enabled: false,
              rejectUnauthorized: true,
            },
      },
    });
    hideConnectionForm();
  }

  function renderConnectionTree() {
    const tree = elements.connectionTree;
    tree.innerHTML = '';

    if (state.tree.length === 0) {
      tree.textContent = 'No connections yet. Use the + action in the view title to add one.';
      return;
    }

    for (const connection of state.tree) {
      const block = document.createElement('div');
      block.className = 'treeConnection';

      const header = document.createElement('div');
      header.className = 'treeConnectionHeader';

      const title = document.createElement('div');
      title.className = 'treeTitle';
      title.textContent = `${connection.name} (${connection.connectionType})`;
      header.appendChild(title);

      const status = document.createElement('span');
      status.className = connection.status === 'connected' ? 'badge ok' : 'badge err';
      status.textContent = connection.status;
      header.appendChild(status);

      const actions = document.createElement('div');
      actions.className = 'inlineButtons';

      const editBtn = document.createElement('button');
      editBtn.className = 'secondary small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        sendRequest('selectConnectionForEdit', { connectionId: connection.connectionId });
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'danger small';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        if (!confirm(`Remove connection "${connection.name}"?`)) {
          return;
        }
        sendRequest('removeConnection', { connectionId: connection.connectionId });
      });

      actions.appendChild(editBtn);
      actions.appendChild(removeBtn);
      header.appendChild(actions);

      block.appendChild(header);

      if (connection.status === 'error') {
        const error = document.createElement('div');
        error.className = 'warning';
        error.textContent = connection.message || 'Connection error';
        block.appendChild(error);
      }

      for (const schema of connection.schemas) {
        const schemaDetails = document.createElement('details');
        schemaDetails.className = 'treeSchema';

        const summary = document.createElement('summary');
        summary.textContent = schema.name;
        schemaDetails.appendChild(summary);

        const objectList = document.createElement('div');
        objectList.className = 'treeObjects';

        for (const object of schema.objects) {
          const objectButton = document.createElement('button');
          objectButton.className = 'treeObject';
          objectButton.textContent = `${object.type === 'view' ? 'VIEW' : 'TABLE'} ${object.name}`;

          if (
            state.selectedObject &&
            state.selectedObject.connectionId === connection.connectionId &&
            state.selectedObject.schema === schema.name &&
            state.selectedObject.objectName === object.name &&
            state.selectedObject.objectType === object.type
          ) {
            objectButton.classList.add('selected');
          }

          objectButton.addEventListener('click', () => {
            state.selectedObject = {
              connectionId: connection.connectionId,
              schema: schema.name,
              objectName: object.name,
              objectType: object.type,
            };

            sendRequest('openTable', {
              connectionId: connection.connectionId,
              schema: schema.name,
              objectName: object.name,
              objectType: object.type,
              pageSize: 50,
            });
            renderConnectionTree();
          });

          objectList.appendChild(objectButton);
        }

        schemaDetails.appendChild(objectList);
        block.appendChild(schemaDetails);
      }

      tree.appendChild(block);
    }
  }

  function showStatus(message, isError = false) {
    elements.statusBar.textContent = message;
    elements.statusBar.classList.toggle('error', isError);

    window.clearTimeout(showStatus._timeout);
    showStatus._timeout = window.setTimeout(() => {
      elements.statusBar.textContent = '';
      elements.statusBar.classList.remove('error');
    }, 5000);
  }

  function normalizeOptional(value) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
})();
