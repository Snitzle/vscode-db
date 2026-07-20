import '@vscode/codicons/dist/codicon.css';
import { getVsCodeApi } from './vscodeApi.js';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { attachClosestEdge, extractClosestEdge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

(() => {
  const vscode = getVsCodeApi();

  // UI state survives the view being hidden, collapsed, or the window reloading.
  const persisted = vscode.getState() || {};

  const state = {
    connections: [],
    tree: [],
    folders: [],
    selectedObject: persisted.selectedObject || null,
    filterTerm: persisted.filterTerm || '',
    collapsedSchemas: new Set(persisted.collapsedSchemas || []),
    collapsedFolders: new Set(persisted.collapsedFolders || []),
    // Per-connection table search terms, keyed by connectionId.
    connectionSearch: persisted.connectionSearch || {},
    connectionForm: {
      visible: false,
      mode: 'add',
      editingId: undefined,
    },
  };

  function persistUiState() {
    vscode.setState({
      selectedObject: state.selectedObject,
      filterTerm: state.filterTerm,
      collapsedSchemas: [...state.collapsedSchemas],
      collapsedFolders: [...state.collapsedFolders],
      connectionSearch: state.connectionSearch,
    });
  }

  // Which connections have their table-search row open (session-only; a saved
  // term reopens the row on reload via the seed below).
  const openSearches = new Set(
    Object.keys(state.connectionSearch).filter((id) => state.connectionSearch[id]),
  );

  // Focus is lost when the tree re-renders on each search keystroke; this asks
  // the next render to restore it to the given connection's search input.
  let pendingSearchFocus = null;

  function schemaKey(connectionId, schemaName) {
    return `${connectionId}::${schemaName}`;
  }

  let requestCounter = 0;

  // Drag-and-drop registrations for the current render. renderConnectionTree()
  // rebuilds the DOM wholesale, so these are torn down and re-created each pass
  // to keep pragmatic-drag-and-drop's registry from retaining detached nodes.
  let connectionDragCleanups = [];

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="root explorerRoot">
      <div class="modal" id="connectionFormPanel" hidden>
        <div class="modalContent">
        <div class="panelHeader">
          <h2 id="connectionFormTitle">Add connection</h2>
          <button id="btnCancelConnectionForm" class="secondary">Close</button>
        </div>

        <form id="connectionForm" class="fieldStack">
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
            <label>Environment
              <div class="inlineInput envSelectRow">
                <select id="connectionEnvironment">
                  <option value="">None</option>
                  <option value="local">Local (green)</option>
                  <option value="staging">Staging (amber)</option>
                  <option value="prod">Production (red)</option>
                </select>
                <span id="envPreview" class="envBadge" hidden></span>
              </div>
            </label>
          </div>

          <div id="sqliteFields" class="fieldStack">
            <label>SQLite File
              <div class="inlineInput">
                <input id="sqliteFilePath" placeholder="/path/to/database.sqlite" />
                <button type="button" id="btnBrowseSqlite" class="secondary">Browse</button>
              </div>
            </label>
          </div>

          <div id="mysqlFields" class="fieldStack" hidden>
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

            <label class="checkboxField" title="Sends the password as clear text over the (ideally TLS-secured) connection — required by LDAP/PAM-backed MySQL servers.">
              <input id="mysqlAllowClearText" type="checkbox" /> Allow cleartext authentication
            </label>

            <details class="formDetails">
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
            <details class="formDetails">
              <summary>SSH tunnel (optional)</summary>
              <div class="fieldStack">
                <label class="checkboxField">
                  <input id="sshEnabled" type="checkbox" /> Connect through an SSH tunnel
                </label>
                <div class="formGrid">
                  <label>SSH Host
                    <input id="sshHost" placeholder="bastion.example.com" />
                  </label>
                  <label>SSH Port
                    <input id="sshPort" type="number" min="1" max="65535" value="22" />
                  </label>
                  <label>SSH User
                    <input id="sshUser" placeholder="deploy" />
                  </label>
                  <label>Authentication
                    <select id="sshAuth">
                      <option value="password">Password</option>
                      <option value="key">Private key</option>
                      <option value="agent">SSH agent</option>
                    </select>
                  </label>
                  <label>Password / key passphrase
                    <input id="sshPassword" type="password" autocomplete="off" />
                  </label>
                  <label>Private key path
                    <input id="sshKeyPath" placeholder="~/.ssh/id_ed25519" />
                  </label>
                </div>
                <label class="checkboxField" id="clearSshPasswordWrap" hidden>
                  <input id="sshClearPassword" type="checkbox" /> Clear stored SSH secret
                </label>
              </div>
            </details>
            <label class="checkboxField" id="clearPasswordWrap" hidden>
              <input id="mysqlClearPassword" type="checkbox" /> Clear stored password
            </label>
          </div>

          <div class="actions">
            <button type="button" id="btnTestConnection" class="secondary">Test connection</button>
            <span class="spacer"></span>
            <button type="submit" id="btnSaveConnection">Save connection</button>
          </div>
          <div id="testConnectionStatus" class="status" hidden></div>
        </form>
        </div>
      </div>

      <section class="panel">
        <div class="treeControls">
          <div class="treeFilter">
            <i class="codicon codicon-search" aria-hidden="true"></i>
            <input id="objectFilter" placeholder="Filter tables and views" />
          </div>
          <button id="btnNewFolder" class="iconBtn" title="New folder" aria-label="New folder"><i class="codicon codicon-new-folder" aria-hidden="true"></i></button>
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
    connectionEnvironment: document.getElementById('connectionEnvironment'),
    envPreview: document.getElementById('envPreview'),
    sshEnabled: document.getElementById('sshEnabled'),
    sshHost: document.getElementById('sshHost'),
    sshPort: document.getElementById('sshPort'),
    sshUser: document.getElementById('sshUser'),
    sshAuth: document.getElementById('sshAuth'),
    sshPassword: document.getElementById('sshPassword'),
    sshKeyPath: document.getElementById('sshKeyPath'),
    clearSshPasswordWrap: document.getElementById('clearSshPasswordWrap'),
    sshClearPassword: document.getElementById('sshClearPassword'),
    sqliteFields: document.getElementById('sqliteFields'),
    sqliteFilePath: document.getElementById('sqliteFilePath'),
    btnBrowseSqlite: document.getElementById('btnBrowseSqlite'),
    mysqlFields: document.getElementById('mysqlFields'),
    mysqlHost: document.getElementById('mysqlHost'),
    mysqlPort: document.getElementById('mysqlPort'),
    mysqlUser: document.getElementById('mysqlUser'),
    mysqlPassword: document.getElementById('mysqlPassword'),
    mysqlDatabase: document.getElementById('mysqlDatabase'),
    mysqlAllowClearText: document.getElementById('mysqlAllowClearText'),
    mysqlSslEnabled: document.getElementById('mysqlSslEnabled'),
    mysqlSslRejectUnauthorized: document.getElementById('mysqlSslRejectUnauthorized'),
    mysqlSslCaPath: document.getElementById('mysqlSslCaPath'),
    mysqlSslCertPath: document.getElementById('mysqlSslCertPath'),
    mysqlSslKeyPath: document.getElementById('mysqlSslKeyPath'),
    mysqlSslServerName: document.getElementById('mysqlSslServerName'),
    clearPasswordWrap: document.getElementById('clearPasswordWrap'),
    mysqlClearPassword: document.getElementById('mysqlClearPassword'),
    connectionTree: document.getElementById('connectionTree'),
    objectFilter: document.getElementById('objectFilter'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnTestConnection: document.getElementById('btnTestConnection'),
    testConnectionStatus: document.getElementById('testConnectionStatus'),
    statusBar: document.getElementById('statusBar'),
  };

  // Add-connection and Refresh live in the view's title bar (contributed via
  // package.json menus), so the webview no longer duplicates them here.
  elements.btnCancelConnectionForm.addEventListener('click', () => hideConnectionForm());
  elements.connectionType.addEventListener('change', updateConnectionTypeFields);
  elements.btnBrowseSqlite.addEventListener('click', () => sendRequest('pickSqliteFile'));
  elements.btnTestConnection.addEventListener('click', () => {
    elements.btnTestConnection.disabled = true;
    elements.testConnectionStatus.hidden = false;
    elements.testConnectionStatus.classList.remove('error', 'success');
    elements.testConnectionStatus.textContent = 'Testing connection…';
    sendRequest('testConnection', { connection: collectConnectionInput() });
  });
  elements.btnNewFolder.addEventListener('click', () => sendRequest('createFolder'));
  elements.connectionEnvironment.addEventListener('change', updateEnvPreview);
  elements.objectFilter.value = state.filterTerm;
  elements.objectFilter.addEventListener('input', () => {
    state.filterTerm = elements.objectFilter.value;
    persistUiState();
    renderConnectionTree();
  });
  elements.connectionFormPanel.addEventListener('click', (event) => {
    if (event.target === elements.connectionFormPanel) {
      hideConnectionForm();
    }
  });

  elements.connectionForm.addEventListener('submit', (event) => {
    event.preventDefault();
    saveConnectionFromForm();
  });

  window.addEventListener('message', (event) => {
    handleEvent(event.data);
  });

  // Any click that isn't on an open kebab menu closes it (menu clicks call
  // stopPropagation), as does Escape.
  document.addEventListener('click', () => closeAllKebabMenus());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAllKebabMenus();
    }
  });

  // A single monitor handles every drop (registering one per card per render
  // would fire the reorder multiple times). The innermost drop target decides
  // what a drop means: another card = reorder (adopting that card's folder),
  // a folder block = move into that folder, the tree background = move to the
  // top level.
  monitorForElements({
    canMonitor: ({ source }) => source.data.type === 'connection' || source.data.type === 'folder',
    onDrop: ({ source, location }) => {
      clearDropIndicators();
      const target = location.current.dropTargets[0];
      if (!target) {
        return;
      }

      if (source.data.type === 'folder') {
        const fromId = source.data.folderId;
        const toId = target.data.type === 'folder' ? target.data.folderId : undefined;
        if (fromId && toId && fromId !== toId) {
          dropFolderOnFolder(fromId, toId, extractClosestEdge(target.data));
        }
        return;
      }

      const fromId = source.data.connectionId;
      if (!fromId) {
        return;
      }
      if (target.data.type === 'connection' && target.data.connectionId !== fromId) {
        dropConnectionOnConnection(fromId, target.data.connectionId, extractClosestEdge(target.data));
      } else if (target.data.type === 'folder-drop') {
        dropConnectionIntoFolder(fromId, target.data.folderId);
      } else if (target.data.type === 'root') {
        dropConnectionOnRoot(fromId);
      }
    },
  });

  // The tree background is the outermost drop target: dropping a foldered
  // connection on empty space moves it back to the top level.
  dropTargetForElements({
    element: elements.connectionTree,
    canDrop: ({ source }) => source.data.type === 'connection',
    getData: () => ({ type: 'root' }),
  });

  sendRequest('ready');

  function handleEvent(message) {
    switch (message.kind) {
      case 'state':
        state.tree = message.tree;
        state.connections = message.connections;
        state.folders = message.folders || [];
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

      case 'testConnectionResult':
        elements.btnTestConnection.disabled = false;
        elements.testConnectionStatus.hidden = false;
        elements.testConnectionStatus.classList.toggle('error', !message.ok);
        elements.testConnectionStatus.classList.toggle('success', message.ok);
        elements.testConnectionStatus.textContent = message.message;
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

    elements.connectionFormTitle.textContent = mode === 'add' ? 'Add connection' : 'Edit connection';
    elements.connectionFormPanel.hidden = false;
    elements.clearPasswordWrap.hidden = mode !== 'edit';
    elements.clearSshPasswordWrap.hidden = mode !== 'edit';
    elements.btnTestConnection.disabled = false;
    elements.testConnectionStatus.hidden = true;
    elements.testConnectionStatus.textContent = '';
    elements.testConnectionStatus.classList.remove('error', 'success');

    if (!connection) {
      elements.connectionType.value = 'sqlite';
      elements.connectionName.value = '';
      elements.connectionEnvironment.value = '';
      elements.sqliteFilePath.value = '';
      elements.mysqlHost.value = '127.0.0.1';
      elements.mysqlPort.value = '3306';
      elements.mysqlUser.value = '';
      elements.mysqlPassword.value = '';
      elements.mysqlDatabase.value = '';
      elements.mysqlAllowClearText.checked = false;
      elements.mysqlSslEnabled.checked = false;
      elements.mysqlSslRejectUnauthorized.checked = true;
      elements.mysqlSslCaPath.value = '';
      elements.mysqlSslCertPath.value = '';
      elements.mysqlSslKeyPath.value = '';
      elements.mysqlSslServerName.value = '';
      elements.mysqlClearPassword.checked = false;
      elements.sshEnabled.checked = false;
      elements.sshHost.value = '';
      elements.sshPort.value = '22';
      elements.sshUser.value = '';
      elements.sshAuth.value = 'password';
      elements.sshPassword.value = '';
      elements.sshKeyPath.value = '';
      elements.sshClearPassword.checked = false;
      updateConnectionTypeFields();
      updateEnvPreview();
      return;
    }

    elements.connectionType.value = connection.type;
    elements.connectionName.value = connection.name;
    elements.connectionEnvironment.value = connection.environment || '';

    if (connection.type === 'sqlite') {
      elements.sqliteFilePath.value = connection.filePath;
    } else {
      elements.mysqlHost.value = connection.host;
      elements.mysqlPort.value = String(connection.port);
      elements.mysqlUser.value = connection.user;
      elements.mysqlPassword.value = '';
      elements.mysqlDatabase.value = connection.database;
      elements.mysqlAllowClearText.checked = Boolean(connection.allowClearTextAuth);
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

      const ssh = connection.sshTunnel;
      elements.sshEnabled.checked = Boolean(ssh && ssh.enabled);
      elements.sshHost.value = ssh && ssh.host ? ssh.host : '';
      elements.sshPort.value = ssh && ssh.port ? String(ssh.port) : '22';
      elements.sshUser.value = ssh && ssh.user ? ssh.user : '';
      elements.sshAuth.value = ssh && ssh.authMethod ? ssh.authMethod : 'password';
      elements.sshPassword.value = '';
      elements.sshKeyPath.value = ssh && ssh.keyPath ? ssh.keyPath : '';
      elements.sshClearPassword.checked = false;
    }

    updateConnectionTypeFields();
    updateEnvPreview();
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

  // Live badge next to the Environment select, showing the colour the tree
  // card (and panel strips) will get.
  function updateEnvPreview() {
    const value = elements.connectionEnvironment.value;
    if (value) {
      elements.envPreview.hidden = false;
      elements.envPreview.className = `envBadge env-${value}`;
      elements.envPreview.textContent = value === 'prod' ? 'production' : value;
    } else {
      elements.envPreview.hidden = true;
    }
  }

  function collectConnectionInput() {
    const environment = elements.connectionEnvironment.value || undefined;

    if (elements.connectionType.value === 'sqlite') {
      return {
        id: state.connectionForm.editingId,
        type: 'sqlite',
        name: elements.connectionName.value.trim(),
        environment,
        filePath: elements.sqliteFilePath.value.trim(),
      };
    }

    const sslEnabled = elements.mysqlSslEnabled.checked;
    return {
      id: state.connectionForm.editingId,
      type: 'mysql',
      name: elements.connectionName.value.trim(),
      environment,
      host: elements.mysqlHost.value.trim(),
      port: Number(elements.mysqlPort.value || 3306),
      user: elements.mysqlUser.value.trim(),
      password: elements.mysqlPassword.value,
      clearPassword: elements.mysqlClearPassword.checked,
      database: elements.mysqlDatabase.value.trim(),
      allowClearTextAuth: elements.mysqlAllowClearText.checked,
      sshTunnel: elements.sshEnabled.checked
        ? {
            enabled: true,
            host: elements.sshHost.value.trim(),
            port: Number(elements.sshPort.value || 22),
            user: elements.sshUser.value.trim(),
            authMethod: elements.sshAuth.value,
            keyPath: normalizeOptional(elements.sshKeyPath.value),
          }
        : undefined,
      sshPassword: elements.sshPassword.value || undefined,
      clearSshPassword: elements.sshClearPassword.checked,
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
    };
  }

  function saveConnectionFromForm() {
    sendRequest('saveConnection', {
      mode: state.connectionForm.mode,
      connection: collectConnectionInput(),
    });
    hideConnectionForm();
  }

  function renderConnectionTree() {
    // Release the previous render's drag registrations before the DOM they were
    // bound to is discarded.
    for (const cleanup of connectionDragCleanups) {
      cleanup();
    }
    connectionDragCleanups = [];

    const tree = elements.connectionTree;
    tree.innerHTML = '';

    if (state.tree.length === 0 && state.folders.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No connections yet. Use the + button in the view title to add one.';
      tree.appendChild(empty);
      return;
    }

    const term = state.filterTerm.trim().toLowerCase();
    // Reordering only makes sense over the full, unfiltered list, and needs
    // somewhere to drop (another card or a folder).
    const dragEnabled = term === '' && (state.tree.length > 1 || state.folders.length > 0);
    const opts = { term, dragEnabled };

    // Folders first (in their saved order), then top-level connections. A
    // folderId pointing at a folder that no longer exists degrades to the top
    // level rather than hiding the connection.
    const folderIds = new Set(state.folders.map((folder) => folder.id));
    const grouped = new Map();
    const rootNodes = [];
    for (const connection of state.tree) {
      if (connection.folderId && folderIds.has(connection.folderId)) {
        if (!grouped.has(connection.folderId)) {
          grouped.set(connection.folderId, []);
        }
        grouped.get(connection.folderId).push(connection);
      } else {
        rootNodes.push(connection);
      }
    }

    for (const folder of state.folders) {
      tree.appendChild(buildFolderBlock(folder, grouped.get(folder.id) || [], opts));
    }
    for (const connection of rootNodes) {
      tree.appendChild(buildConnectionCard(connection, opts));
    }

    restoreSearchFocus();
  }

  function buildConnectionCard(connection, { term, dragEnabled }) {
      const block = document.createElement('div');
      block.className = 'treeConnection';
      if (connection.environment) {
        block.dataset.env = connection.environment;
      }

      const header = document.createElement('div');
      header.className = 'treeConnectionHeader';

      let dragHandleEl = null;
      if (dragEnabled) {
        header.classList.add('draggable');
        dragHandleEl = document.createElement('button');
        dragHandleEl.type = 'button';
        dragHandleEl.className = 'dragHandle';
        dragHandleEl.title = 'Drag to reorder';
        dragHandleEl.setAttribute('aria-label', `Reorder connection ${connection.name}`);
        dragHandleEl.innerHTML = '<i class="codicon codicon-gripper" aria-hidden="true"></i>';
        header.appendChild(dragHandleEl);
      }

      const title = document.createElement('div');
      title.className = 'treeTitle';
      const connectionIcon = connection.connectionType === 'mysql' ? 'codicon-server' : 'codicon-database';
      const envBadge = connection.environment
        ? `<span class="envBadge env-${escapeHtml(connection.environment)}">${escapeHtml(
            connection.environment === 'prod' ? 'production' : connection.environment,
          )}</span>`
        : '';
      title.innerHTML =
        `<i class="codicon ${connectionIcon}" aria-hidden="true"></i>` +
        `<span class="treeName">${escapeHtml(connection.name)}</span>` +
        envBadge +
        `<span class="treeType">${escapeHtml(connection.connectionType)}</span>`;
      header.appendChild(title);

      const status = document.createElement('span');
      if (connection.status === 'connected') {
        status.className = 'statusDot ok';
        status.title = 'Connected';
      } else if (connection.status === 'disconnected') {
        status.className = 'statusDot off';
        status.title = 'Not connected';
      } else {
        status.className = 'statusDot err';
        status.title = connection.message || 'Connection error';
      }
      status.innerHTML = '<i class="codicon codicon-circle-filled" aria-hidden="true"></i>';
      header.appendChild(status);

      const actions = document.createElement('div');
      actions.className = 'inlineButtons';

      const isConnected = connection.status === 'connected';
      const connectBtn = document.createElement('button');
      connectBtn.type = 'button';
      connectBtn.className = 'iconBtn';
      connectBtn.title = isConnected ? 'Reload connection' : 'Connect';
      connectBtn.setAttribute(
        'aria-label',
        `${isConnected ? 'Reload' : 'Connect'} connection ${connection.name}`,
      );
      connectBtn.innerHTML = `<i class="codicon ${isConnected ? 'codicon-refresh' : 'codicon-plug'}" aria-hidden="true"></i>`;
      connectBtn.addEventListener('click', () => {
        connectBtn.disabled = true;
        showStatus(`Connecting to ${connection.name}…`);
        sendRequest('connectConnection', { connectionId: connection.connectionId });
      });
      actions.appendChild(connectBtn);

      const connTerm = (state.connectionSearch[connection.connectionId] || '').trim().toLowerCase();
      const searchOpen = openSearches.has(connection.connectionId);

      if (connection.schemas.some((schema) => schema.objects.length > 0)) {
        const searchBtn = document.createElement('button');
        searchBtn.type = 'button';
        searchBtn.className = 'iconBtn';
        searchBtn.title = 'Search tables in this connection';
        searchBtn.setAttribute('aria-label', `Search tables in ${connection.name}`);
        searchBtn.setAttribute('aria-pressed', String(searchOpen));
        searchBtn.innerHTML = '<i class="codicon codicon-search" aria-hidden="true"></i>';
        searchBtn.addEventListener('click', () => toggleConnectionSearch(connection.connectionId));
        actions.appendChild(searchBtn);
      }

      const menuItems = [];
      if (connection.status === 'connected') {
        menuItems.push({
          label: 'New query',
          icon: 'codicon-terminal',
          onSelect: () => sendRequest('openQueryPanel', { connectionId: connection.connectionId }),
        });
        menuItems.push({
          label: 'Import SQL file…',
          icon: 'codicon-cloud-upload',
          onSelect: () => sendRequest('importSql', { connectionId: connection.connectionId }),
        });
        menuItems.push({
          label: 'Export database…',
          icon: 'codicon-desktop-download',
          onSelect: () => sendRequest('exportDatabase', { connectionId: connection.connectionId }),
        });
        menuItems.push({
          label: 'Disconnect',
          icon: 'codicon-debug-disconnect',
          onSelect: () => sendRequest('disconnectConnection', { connectionId: connection.connectionId }),
        });
      }
      menuItems.push({
        label: 'Edit connection',
        icon: 'codicon-edit',
        onSelect: () => sendRequest('selectConnectionForEdit', { connectionId: connection.connectionId }),
      });
      menuItems.push({
        label: 'Remove connection',
        icon: 'codicon-trash',
        danger: true,
        // Confirmation happens host-side via a native modal — webview confirm()
        // is blocked in the VS Code webview sandbox.
        onSelect: () => sendRequest('removeConnection', { connectionId: connection.connectionId }),
      });

      actions.appendChild(buildKebabMenu(menuItems));
      header.appendChild(actions);

      block.appendChild(header);

      if (connection.status === 'error') {
        const error = document.createElement('div');
        error.className = 'warning';
        error.textContent = connection.message || 'Connection error';
        block.appendChild(error);
      }

      if (connection.status === 'disconnected') {
        const hint = document.createElement('div');
        hint.className = 'muted treeNoMatch';
        hint.textContent = 'Not connected — use the plug button to connect.';
        block.appendChild(hint);
      }

      if (searchOpen) {
        block.appendChild(buildConnectionSearchRow(connection.connectionId));
      }

      const anyTermActive = Boolean(term || connTerm);
      let matchesShown = 0;

      for (const schema of connection.schemas) {
        const matchingObjects = anyTermActive
          ? schema.objects.filter((object) => {
              const name = object.name.toLowerCase();
              return (!term || name.includes(term)) && (!connTerm || name.includes(connTerm));
            })
          : schema.objects;

        if (anyTermActive && matchingObjects.length === 0) {
          continue;
        }
        matchesShown += matchingObjects.length;

        const schemaDetails = document.createElement('details');
        schemaDetails.className = 'treeSchema';
        // Schemas default to open; a collapsed set (not an expanded one) means
        // newly discovered schemas start expanded. An active filter forces
        // everything open so matches are visible, without touching saved state.
        const key = schemaKey(connection.connectionId, schema.name);
        schemaDetails.open = anyTermActive ? true : !state.collapsedSchemas.has(key);
        schemaDetails.addEventListener('toggle', () => {
          if (state.filterTerm.trim() || (state.connectionSearch[connection.connectionId] || '').trim()) {
            return;
          }
          if (schemaDetails.open) {
            state.collapsedSchemas.delete(key);
          } else {
            state.collapsedSchemas.add(key);
          }
          persistUiState();
        });

        const summary = document.createElement('summary');
        const tableCount = schema.objects.filter((object) => object.type !== 'view').length;
        const viewCount = schema.objects.filter((object) => object.type === 'view').length;
        const counts = [];
        if (tableCount) {
          counts.push(`${tableCount} table${tableCount === 1 ? '' : 's'}`);
        }
        if (viewCount) {
          counts.push(`${viewCount} view${viewCount === 1 ? '' : 's'}`);
        }
        summary.innerHTML =
          '<i class="codicon codicon-chevron-right treeChevron" aria-hidden="true"></i>' +
          '<i class="codicon codicon-symbol-namespace" aria-hidden="true"></i>' +
          `<span class="schemaName">${escapeHtml(schema.name)}</span>` +
          `<span class="schemaCount">${escapeHtml(counts.join(' · '))}</span>`;
        schemaDetails.appendChild(summary);

        const objectList = document.createElement('div');
        objectList.className = 'treeObjects';

        for (const object of matchingObjects) {
          const objectButton = document.createElement('button');
          objectButton.className = 'treeObject';
          const objectIcon = object.type === 'view' ? 'codicon-eye' : 'codicon-table';
          objectButton.innerHTML =
            `<i class="codicon ${objectIcon}" aria-hidden="true"></i>` +
            `<span class="objectName">${escapeHtml(object.name)}</span>`;
          objectButton.title = `${object.type === 'view' ? 'View' : 'Table'} ${schema.name}.${object.name}`;

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
            persistUiState();

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

      if (anyTermActive && matchesShown === 0 && connection.schemas.length > 0) {
        const noMatch = document.createElement('div');
        noMatch.className = 'muted treeNoMatch';
        noMatch.textContent = 'No tables or views match.';
        block.appendChild(noMatch);
      }

      if (dragHandleEl) {
        registerConnectionDrag(block, dragHandleEl, connection.connectionId);
      }

      return block;
  }

  function buildFolderBlock(folder, connections, opts) {
    const block = document.createElement('div');
    block.className = 'treeFolder';
    const collapsed = state.collapsedFolders.has(folder.id);
    if (collapsed) {
      block.classList.add('collapsed');
    }

    const header = document.createElement('div');
    header.className = 'treeFolderHeader';

    let handle = null;
    if (opts.dragEnabled && state.folders.length > 1) {
      header.classList.add('draggable');
      handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'dragHandle';
      handle.title = 'Drag to reorder';
      handle.setAttribute('aria-label', `Reorder folder ${folder.name}`);
      handle.innerHTML = '<i class="codicon codicon-gripper" aria-hidden="true"></i>';
      header.appendChild(handle);
    }

    const title = document.createElement('div');
    title.className = 'treeTitle';
    title.innerHTML =
      '<i class="codicon codicon-chevron-right treeChevron" aria-hidden="true"></i>' +
      `<i class="codicon ${collapsed ? 'codicon-folder' : 'codicon-folder-opened'}" aria-hidden="true"></i>` +
      `<span class="treeName">${escapeHtml(folder.name)}</span>` +
      `<span class="treeType">${connections.length} connection${connections.length === 1 ? '' : 's'}</span>`;
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'inlineButtons';
    actions.appendChild(
      buildKebabMenu([
        {
          label: 'Rename folder',
          icon: 'codicon-edit',
          onSelect: () => sendRequest('renameFolder', { folderId: folder.id }),
        },
        {
          label: 'Remove folder',
          icon: 'codicon-trash',
          danger: true,
          // Host-side modal confirms; members return to the top level.
          onSelect: () => sendRequest('removeFolder', { folderId: folder.id }),
        },
      ]),
    );
    header.appendChild(actions);

    header.addEventListener('click', (event) => {
      if (event.target.closest('button')) {
        return;
      }
      if (state.collapsedFolders.has(folder.id)) {
        state.collapsedFolders.delete(folder.id);
      } else {
        state.collapsedFolders.add(folder.id);
      }
      persistUiState();
      renderConnectionTree();
    });

    block.appendChild(header);

    if (!collapsed) {
      const body = document.createElement('div');
      body.className = 'treeFolderBody';
      if (connections.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'muted treeNoMatch';
        hint.textContent = 'Empty folder — drag connections here.';
        body.appendChild(hint);
      }
      for (const connection of connections) {
        body.appendChild(buildConnectionCard(connection, opts));
      }
      block.appendChild(body);
    }

    if (opts.dragEnabled) {
      registerFolderDrag(block, handle, folder.id);
    }

    return block;
  }

  function toggleConnectionSearch(connectionId) {
    if (openSearches.has(connectionId)) {
      openSearches.delete(connectionId);
      // Closing the row also drops its filter so the tree returns to normal.
      delete state.connectionSearch[connectionId];
      persistUiState();
    } else {
      openSearches.add(connectionId);
      pendingSearchFocus = { connectionId, caret: 0 };
    }
    renderConnectionTree();
  }

  function buildConnectionSearchRow(connectionId) {
    const wrap = document.createElement('div');
    wrap.className = 'connSearch';
    wrap.innerHTML = '<i class="codicon codicon-search" aria-hidden="true"></i>';

    const input = document.createElement('input');
    input.placeholder = 'Search tables and views';
    input.value = state.connectionSearch[connectionId] || '';
    input.dataset.connSearch = connectionId;
    input.addEventListener('input', () => {
      state.connectionSearch[connectionId] = input.value;
      persistUiState();
      pendingSearchFocus = { connectionId, caret: input.selectionStart };
      renderConnectionTree();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        toggleConnectionSearch(connectionId);
      }
    });
    wrap.appendChild(input);

    return wrap;
  }

  function restoreSearchFocus() {
    if (!pendingSearchFocus) {
      return;
    }
    const { connectionId, caret } = pendingSearchFocus;
    pendingSearchFocus = null;
    const input = elements.connectionTree.querySelector(
      `input[data-conn-search="${CSS.escape(connectionId)}"]`,
    );
    if (input) {
      input.focus();
      const position = caret ?? input.value.length;
      input.setSelectionRange(position, position);
    }
  }

  // Wires one connection card as both a drag source (via its grip handle) and a
  // drop target. The closest-edge hitbox drives the top/bottom drop indicator;
  // the actual reorder is handled centrally by the monitor registered at init.
  function registerConnectionDrag(block, handle, connectionId) {
    connectionDragCleanups.push(
      draggable({
        element: block,
        dragHandle: handle,
        getInitialData: () => ({ type: 'connection', connectionId }),
        onDragStart: () => block.classList.add('dragging'),
        onDrop: () => block.classList.remove('dragging'),
      }),
      dropTargetForElements({
        element: block,
        canDrop: ({ source }) => source.data.type === 'connection',
        getData: ({ input, element }) =>
          attachClosestEdge(
            { type: 'connection', connectionId },
            { input, element, allowedEdges: ['top', 'bottom'] },
          ),
        getIsSticky: () => true,
        onDrag: ({ self, source }) => {
          const edge = source.element === block ? null : extractClosestEdge(self.data);
          if (edge) {
            block.dataset.dropEdge = edge;
          } else {
            delete block.dataset.dropEdge;
          }
        },
        onDragLeave: () => delete block.dataset.dropEdge,
        onDrop: () => delete block.dataset.dropEdge,
      }),
    );
  }

  // Wires a folder block as a drag source (reorder via its grip handle) and a
  // drop target — for folder drags it reorders with the closest-edge indicator;
  // for connection drags it means "move into this folder".
  function registerFolderDrag(block, handle, folderId) {
    if (handle) {
      connectionDragCleanups.push(
        draggable({
          element: block,
          dragHandle: handle,
          getInitialData: () => ({ type: 'folder', folderId }),
          onDragStart: () => block.classList.add('dragging'),
          onDrop: () => block.classList.remove('dragging'),
        }),
      );
    }

    connectionDragCleanups.push(
      dropTargetForElements({
        element: block,
        canDrop: ({ source }) =>
          source.data.type === 'connection' ||
          (source.data.type === 'folder' && source.data.folderId !== folderId),
        getData: ({ input, element, source }) =>
          source.data.type === 'folder'
            ? attachClosestEdge({ type: 'folder', folderId }, { input, element, allowedEdges: ['top', 'bottom'] })
            : { type: 'folder-drop', folderId },
        getIsSticky: () => true,
        onDrag: ({ self, source, location }) => {
          if (source.data.type === 'folder') {
            const edge = extractClosestEdge(self.data);
            if (edge) {
              block.dataset.dropEdge = edge;
            } else {
              delete block.dataset.dropEdge;
            }
            return;
          }
          // Highlight only while the folder itself (not a card inside it) is
          // the innermost target.
          const inner = location.current.dropTargets[0];
          block.classList.toggle('dropInto', Boolean(inner && inner.element === block));
        },
        onDragLeave: () => {
          delete block.dataset.dropEdge;
          block.classList.remove('dropInto');
        },
        onDrop: () => {
          delete block.dataset.dropEdge;
          block.classList.remove('dropInto');
        },
      }),
    );
  }

  function clearDropIndicators() {
    for (const element of document.querySelectorAll('[data-drop-edge]')) {
      delete element.dataset.dropEdge;
    }
    for (const element of document.querySelectorAll('.dropInto')) {
      element.classList.remove('dropInto');
    }
  }

  // The local move/reorder helpers update the webview state immediately for a
  // responsive drop, then ask the host to persist. The host echoes back a fresh
  // `state`, which reconciles anything the optimistic move got wrong.

  function dropConnectionOnConnection(fromId, toId, edge) {
    const order = state.tree.map((connection) => connection.connectionId);
    const fromIndex = order.indexOf(fromId);
    if (fromIndex === -1) {
      return;
    }

    order.splice(fromIndex, 1);
    const toIndex = order.indexOf(toId);
    if (toIndex === -1) {
      return;
    }
    order.splice(edge === 'bottom' ? toIndex + 1 : toIndex, 0, fromId);

    // Dropping next to a card also adopts that card's folder (or lack of one).
    const target = state.tree.find((connection) => connection.connectionId === toId);
    applyConnectionMove(fromId, target && target.folderId ? target.folderId : null, order);
  }

  function dropConnectionIntoFolder(fromId, folderId) {
    const order = state.tree.map((connection) => connection.connectionId).filter((id) => id !== fromId);

    // Append after the folder's last member; an empty folder appends at the
    // end of the global order (position within it is invisible anyway).
    let insertAt = order.length;
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const node = state.tree.find((connection) => connection.connectionId === order[index]);
      if (node && node.folderId === folderId) {
        insertAt = index + 1;
        break;
      }
    }
    order.splice(insertAt, 0, fromId);

    applyConnectionMove(fromId, folderId, order);
  }

  function dropConnectionOnRoot(fromId) {
    const source = state.tree.find((connection) => connection.connectionId === fromId);
    if (!source || !source.folderId) {
      // Already at the top level: dropping on empty space is a no-op rather
      // than a surprise move-to-end.
      return;
    }

    const order = state.tree.map((connection) => connection.connectionId).filter((id) => id !== fromId);
    order.push(fromId);
    applyConnectionMove(fromId, null, order);
  }

  function applyConnectionMove(fromId, folderId, order) {
    const rank = new Map(order.map((id, index) => [id, index]));
    const byRank = (getId) => (a, b) => rank.get(getId(a)) - rank.get(getId(b));
    state.tree = [...state.tree].sort(byRank((connection) => connection.connectionId));
    state.connections = [...state.connections].sort(byRank((connection) => connection.id));
    for (const node of state.tree) {
      if (node.connectionId === fromId) {
        node.folderId = folderId ?? undefined;
      }
    }
    for (const connection of state.connections) {
      if (connection.id === fromId) {
        connection.folderId = folderId ?? undefined;
      }
    }

    renderConnectionTree();
    sendRequest('moveConnection', { connectionId: fromId, folderId, orderedIds: order });
  }

  function dropFolderOnFolder(fromId, toId, edge) {
    const order = state.folders.map((folder) => folder.id);
    const fromIndex = order.indexOf(fromId);
    if (fromIndex === -1) {
      return;
    }

    order.splice(fromIndex, 1);
    const toIndex = order.indexOf(toId);
    if (toIndex === -1) {
      return;
    }
    order.splice(edge === 'bottom' ? toIndex + 1 : toIndex, 0, fromId);

    const rank = new Map(order.map((id, index) => [id, index]));
    state.folders = [...state.folders].sort((a, b) => rank.get(a.id) - rank.get(b.id));

    renderConnectionTree();
    sendRequest('reorderFolders', { orderedIds: order });
  }

  function buildKebabMenu(items) {
    const wrap = document.createElement('div');
    wrap.className = 'kebabMenu';

    const trigger = document.createElement('button');
    trigger.className = 'iconBtn';
    trigger.title = 'More actions';
    trigger.setAttribute('aria-label', 'More actions');
    trigger.setAttribute('aria-haspopup', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<i class="codicon codicon-ellipsis" aria-hidden="true"></i>';

    const dropdown = document.createElement('div');
    dropdown.className = 'kebabDropdown';
    dropdown.hidden = true;

    for (const item of items) {
      const entry = document.createElement('button');
      entry.className = item.danger ? 'kebabItem danger' : 'kebabItem';
      entry.innerHTML =
        `<i class="codicon ${item.icon}" aria-hidden="true"></i>` +
        `<span>${escapeHtml(item.label)}</span>`;
      entry.addEventListener('click', (event) => {
        event.stopPropagation();
        closeAllKebabMenus();
        item.onSelect();
      });
      dropdown.appendChild(entry);
    }

    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      const willOpen = dropdown.hidden;
      closeAllKebabMenus();
      if (willOpen) {
        dropdown.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
      }
    });

    wrap.appendChild(trigger);
    wrap.appendChild(dropdown);
    return wrap;
  }

  function closeAllKebabMenus() {
    for (const dropdown of document.querySelectorAll('.kebabDropdown')) {
      dropdown.hidden = true;
    }
    for (const trigger of document.querySelectorAll('.kebabMenu .iconBtn')) {
      trigger.setAttribute('aria-expanded', 'false');
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

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
})();
