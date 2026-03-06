(() => {
  const vscode = acquireVsCodeApi();

  const state = {
    activeTable: null,
    selectedRowKeys: new Set(),
    pendingEdits: new Map(),
    ddl: {
      title: '',
      text: '',
      objectType: 'table',
    },
  };

  let requestCounter = 0;

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="root">
      <div class="toolbar">
        <div class="toolbarTitle">
          <h1 id="tableTitle">Loading table...</h1>
          <div id="tableMeta" class="muted">Waiting for database rows.</div>
        </div>
        <div class="inlineButtons">
          <button id="btnRefreshTable" class="secondary">Refresh</button>
          <button id="btnViewDdl" class="secondary" disabled>View DDL</button>
        </div>
      </div>

      <div id="tableWarning" class="warning" hidden></div>

      <section class="panel">
        <div id="tableControls" hidden>
          <div class="controlsRow">
            <label>Page size
              <select id="pageSize">
                <option value="25">25</option>
                <option value="50" selected>50</option>
                <option value="100">100</option>
                <option value="250">250</option>
              </select>
            </label>
            <button id="btnPrevPage" class="secondary">Previous</button>
            <button id="btnNextPage" class="secondary">Next</button>
            <span id="pageInfo" class="muted"></span>
          </div>

          <div class="controlsRow">
            <label>Filter column
              <select id="filterColumn"></select>
            </label>
            <label>Operator
              <select id="filterOperator">
                <option value="eq">=</option>
                <option value="neq">!=</option>
                <option value="gt">&gt;</option>
                <option value="gte">&gt;=</option>
                <option value="lt">&lt;</option>
                <option value="lte">&lt;=</option>
                <option value="contains">contains</option>
                <option value="startsWith">starts with</option>
                <option value="endsWith">ends with</option>
                <option value="isNull">is null</option>
                <option value="isNotNull">is not null</option>
              </select>
            </label>
            <label>Value
              <input id="filterValue" placeholder="filter value" />
            </label>
            <button id="btnApplyFilter" class="secondary">Apply Filter</button>
            <button id="btnClearFilter" class="secondary">Clear Filter</button>
          </div>

          <div class="controlsRow">
            <button id="btnAddRow">Add Row</button>
            <button id="btnDuplicateRow" class="secondary">Duplicate Selected</button>
            <button id="btnDeleteRows" class="danger">Delete Selected</button>
            <button id="btnApplyEdits" class="secondary">Apply Changes</button>
            <button id="btnCancelEdits" class="secondary">Cancel Changes</button>
          </div>
        </div>

        <div id="tableGridWrap" class="gridWrap"></div>
      </section>

      <section class="panel">
        <div class="panelHeader">
          <h2 id="ddlTitle">DDL Viewer</h2>
          <div class="inlineButtons">
            <button id="btnCopyDdl" class="secondary" disabled>Copy</button>
            <button id="btnOpenDdl" class="secondary" disabled>Open In Editor</button>
          </div>
        </div>
        <pre id="ddlOutput" class="ddl">Click "View DDL" to load the current object definition.</pre>
      </section>

      <div id="statusBar" class="status"></div>
    </div>

    <div id="rowModal" class="modal" hidden>
      <div class="modalContent">
        <div class="panelHeader">
          <h2>Add Row</h2>
          <button id="btnCloseRowModal" class="secondary">Close</button>
        </div>
        <form id="rowForm"></form>
        <div class="actions">
          <button id="btnSubmitRow" type="button">Insert Row</button>
        </div>
      </div>
    </div>
  `;

  const elements = {
    tableTitle: document.getElementById('tableTitle'),
    tableMeta: document.getElementById('tableMeta'),
    btnRefreshTable: document.getElementById('btnRefreshTable'),
    tableWarning: document.getElementById('tableWarning'),
    tableControls: document.getElementById('tableControls'),
    tableGridWrap: document.getElementById('tableGridWrap'),
    btnViewDdl: document.getElementById('btnViewDdl'),
    pageSize: document.getElementById('pageSize'),
    btnPrevPage: document.getElementById('btnPrevPage'),
    btnNextPage: document.getElementById('btnNextPage'),
    pageInfo: document.getElementById('pageInfo'),
    filterColumn: document.getElementById('filterColumn'),
    filterOperator: document.getElementById('filterOperator'),
    filterValue: document.getElementById('filterValue'),
    btnApplyFilter: document.getElementById('btnApplyFilter'),
    btnClearFilter: document.getElementById('btnClearFilter'),
    btnAddRow: document.getElementById('btnAddRow'),
    btnDuplicateRow: document.getElementById('btnDuplicateRow'),
    btnDeleteRows: document.getElementById('btnDeleteRows'),
    btnApplyEdits: document.getElementById('btnApplyEdits'),
    btnCancelEdits: document.getElementById('btnCancelEdits'),
    ddlTitle: document.getElementById('ddlTitle'),
    ddlOutput: document.getElementById('ddlOutput'),
    btnCopyDdl: document.getElementById('btnCopyDdl'),
    btnOpenDdl: document.getElementById('btnOpenDdl'),
    statusBar: document.getElementById('statusBar'),
    rowModal: document.getElementById('rowModal'),
    rowForm: document.getElementById('rowForm'),
    btnCloseRowModal: document.getElementById('btnCloseRowModal'),
    btnSubmitRow: document.getElementById('btnSubmitRow'),
  };

  elements.btnRefreshTable.addEventListener('click', () => sendRequest('refreshTable'));
  elements.btnPrevPage.addEventListener('click', () => changePage(-1));
  elements.btnNextPage.addEventListener('click', () => changePage(1));
  elements.pageSize.addEventListener('change', () => {
    if (!state.activeTable) {
      return;
    }

    state.activeTable.pageSize = Number(elements.pageSize.value);
    state.activeTable.page = 0;
    queryActiveTable();
  });

  elements.btnApplyFilter.addEventListener('click', () => {
    if (!state.activeTable) {
      return;
    }

    const operator = elements.filterOperator.value;
    const filter = {
      column: elements.filterColumn.value,
      operator,
    };

    if (operator !== 'isNull' && operator !== 'isNotNull') {
      filter.value = parseInputToScalar(elements.filterValue.value, getColumnByName(elements.filterColumn.value));
    }

    state.activeTable.filter = filter;
    state.activeTable.page = 0;
    queryActiveTable();
  });

  elements.btnClearFilter.addEventListener('click', () => {
    if (!state.activeTable) {
      return;
    }

    state.activeTable.filter = undefined;
    elements.filterValue.value = '';
    state.activeTable.page = 0;
    queryActiveTable();
  });

  elements.btnApplyEdits.addEventListener('click', () => applyPendingEdits());
  elements.btnCancelEdits.addEventListener('click', () => {
    state.pendingEdits.clear();
    renderTable();
  });

  elements.btnAddRow.addEventListener('click', () => openAddRowModal());
  elements.btnCloseRowModal.addEventListener('click', () => closeAddRowModal());
  elements.btnSubmitRow.addEventListener('click', () => submitAddRow());
  elements.btnDuplicateRow.addEventListener('click', () => duplicateSelectedRow());
  elements.btnDeleteRows.addEventListener('click', () => deleteSelectedRows());

  elements.btnViewDdl.addEventListener('click', () => {
    if (!state.activeTable) {
      return;
    }

    sendRequest('viewDdl');
  });

  elements.btnCopyDdl.addEventListener('click', async () => {
    if (!state.ddl.text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(state.ddl.text);
      showStatus('DDL copied to clipboard.');
    } catch (error) {
      showStatus('Copy failed. Use Open In Editor and copy from there.', true);
      console.error(error);
    }
  });

  elements.btnOpenDdl.addEventListener('click', () => {
    if (!state.ddl.text) {
      return;
    }

    sendRequest('openDdlInEditor', {
      title: state.ddl.title,
      ddl: state.ddl.text,
    });
  });

  window.addEventListener('message', (event) => {
    handleEvent(event.data);
  });

  sendRequest('ready');

  function handleEvent(message) {
    switch (message.kind) {
      case 'tableData':
        state.activeTable = {
          connectionId: message.connectionId,
          schema: message.info.schema,
          table: message.info.name,
          objectType: message.info.objectType,
          page: message.page,
          pageSize: message.pageSize,
          sort: message.sort,
          filter: message.filter,
          info: message.info,
          rows: message.rows,
          totalCount: message.totalCount,
        };
        elements.pageSize.value = String(message.pageSize);
        state.pendingEdits.clear();
        state.selectedRowKeys.clear();
        renderTable();
        populateFilterColumns();
        break;

      case 'ddl':
        state.ddl = {
          title: `${message.schema}.${message.objectName}`,
          text: message.ddl,
          objectType: message.objectType,
        };
        renderDdl();
        break;

      case 'mutationApplied':
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

  function populateFilterColumns() {
    if (!state.activeTable) {
      elements.filterColumn.innerHTML = '';
      return;
    }

    elements.filterColumn.innerHTML = '';
    for (const column of state.activeTable.info.columns) {
      const option = document.createElement('option');
      option.value = column.name;
      option.textContent = column.name;
      elements.filterColumn.appendChild(option);
    }

    if (state.activeTable.filter) {
      elements.filterColumn.value = state.activeTable.filter.column;
      elements.filterOperator.value = state.activeTable.filter.operator;
      if (state.activeTable.filter.value !== undefined && state.activeTable.filter.value !== null) {
        elements.filterValue.value = String(state.activeTable.filter.value);
      } else {
        elements.filterValue.value = '';
      }
      return;
    }

    if (state.activeTable.info.columns.length > 0) {
      elements.filterColumn.value = state.activeTable.info.columns[0].name;
    }
  }

  function renderTable() {
    if (!state.activeTable) {
      elements.tableTitle.textContent = 'Loading table...';
      elements.tableMeta.textContent = 'Waiting for database rows.';
      elements.tableControls.hidden = true;
      elements.tableGridWrap.innerHTML = '';
      elements.btnViewDdl.disabled = true;
      elements.tableWarning.hidden = true;
      elements.pageInfo.textContent = '';
      return;
    }

    const active = state.activeTable;
    elements.tableTitle.textContent = `${active.info.schema}.${active.info.name}`;
    elements.tableControls.hidden = false;
    elements.btnViewDdl.disabled = false;

    const start = active.page * active.pageSize + 1;
    const end = active.page * active.pageSize + active.rows.length;
    const total = active.totalCount !== undefined ? active.totalCount : '?';
    elements.pageInfo.textContent = active.rows.length
      ? `Rows ${start}-${end} of ${total}`
      : `No rows. Total ${total}`;
    elements.tableMeta.textContent = `${active.info.objectType.toUpperCase()} • ${active.info.columns.length} columns`;

    if (active.info.readOnly) {
      elements.tableWarning.hidden = false;
      elements.tableWarning.textContent = active.info.readOnlyReason || 'Read-only object.';
    } else {
      elements.tableWarning.hidden = true;
      elements.tableWarning.textContent = '';
    }

    elements.btnAddRow.disabled = active.info.readOnly;
    elements.btnDeleteRows.disabled = active.info.readOnly;
    elements.btnDuplicateRow.disabled = active.info.readOnly;
    elements.btnApplyEdits.disabled = active.info.readOnly;
    elements.btnCancelEdits.disabled = active.info.readOnly;

    const table = document.createElement('table');
    table.className = 'grid';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const selectHeader = document.createElement('th');
    selectHeader.textContent = '';
    headerRow.appendChild(selectHeader);

    for (const column of active.info.columns) {
      const th = document.createElement('th');
      const sort = active.sort && active.sort.column === column.name ? active.sort.direction : '';
      th.innerHTML = `<button class="headerSort" data-column="${escapeHtml(column.name)}">${escapeHtml(
        column.name,
      )}${sort === 'asc' ? ' ▲' : sort === 'desc' ? ' ▼' : ''}</button>`;
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    for (const row of active.rows) {
      const tr = document.createElement('tr');
      const rowKey = rowKeyString(row.key);
      const rowEdit = rowKey ? state.pendingEdits.get(rowKey) : undefined;

      const selectCell = document.createElement('td');
      if (row.key) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = state.selectedRowKeys.has(rowKey);
        checkbox.addEventListener('change', () => {
          if (!rowKey) {
            return;
          }

          if (checkbox.checked) {
            state.selectedRowKeys.add(rowKey);
          } else {
            state.selectedRowKeys.delete(rowKey);
          }
        });
        selectCell.appendChild(checkbox);
      }
      tr.appendChild(selectCell);

      for (const column of active.info.columns) {
        const td = document.createElement('td');
        const currentValue =
          rowEdit && Object.prototype.hasOwnProperty.call(rowEdit.changes, column.name)
            ? rowEdit.changes[column.name]
            : row.values[column.name];

        const valueText = scalarToText(currentValue);
        const isKeyColumn = active.info.writableKey.columns.includes(column.name);
        const editable = !active.info.readOnly && row.key && !column.isAutoIncrement && !isKeyColumn;

        if (!editable) {
          td.textContent = valueText;
        } else {
          const input = document.createElement('input');
          input.className = 'cellInput';
          input.value = valueText === 'NULL' ? '' : valueText;
          input.placeholder = column.nullable ? 'NULL' : '';
          input.dataset.rowKey = rowKey;
          input.dataset.column = column.name;
          input.addEventListener('change', () => {
            onCellEdit(row, column, input.value);
          });
          td.appendChild(input);
        }

        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    elements.tableGridWrap.innerHTML = '';
    elements.tableGridWrap.appendChild(table);

    for (const button of elements.tableGridWrap.querySelectorAll('.headerSort')) {
      button.addEventListener('click', (event) => {
        const column = event.currentTarget.dataset.column;
        toggleSort(column);
      });
    }
  }

  function onCellEdit(row, column, rawInput) {
    if (!row.key) {
      return;
    }

    const parsed = parseInputToScalar(rawInput, column);
    const original = row.values[column.name];
    const key = rowKeyString(row.key);

    if (!key) {
      return;
    }

    const areEqual = scalarEquals(parsed, original);
    const existing = state.pendingEdits.get(key) || { key: row.key, changes: {} };

    if (areEqual) {
      delete existing.changes[column.name];
    } else {
      existing.changes[column.name] = parsed;
    }

    if (Object.keys(existing.changes).length === 0) {
      state.pendingEdits.delete(key);
    } else {
      state.pendingEdits.set(key, existing);
    }
  }

  function toggleSort(column) {
    if (!state.activeTable || !column) {
      return;
    }

    const existing = state.activeTable.sort;
    if (!existing || existing.column !== column) {
      state.activeTable.sort = { column, direction: 'asc' };
    } else if (existing.direction === 'asc') {
      state.activeTable.sort = { column, direction: 'desc' };
    } else {
      state.activeTable.sort = undefined;
    }

    state.activeTable.page = 0;
    queryActiveTable();
  }

  function changePage(delta) {
    if (!state.activeTable) {
      return;
    }

    state.activeTable.page = Math.max(0, state.activeTable.page + delta);
    queryActiveTable();
  }

  function queryActiveTable() {
    if (!state.activeTable) {
      return;
    }

    sendRequest('queryTableRows', {
      page: state.activeTable.page,
      pageSize: state.activeTable.pageSize,
      sort: state.activeTable.sort,
      filter: state.activeTable.filter,
    });
  }

  function applyPendingEdits() {
    if (!state.activeTable) {
      return;
    }

    const updates = [...state.pendingEdits.values()].filter((item) => Object.keys(item.changes).length > 0);
    if (updates.length === 0) {
      showStatus('No pending changes.');
      return;
    }

    sendRequest('updateRows', {
      payload: {
        schema: state.activeTable.schema,
        table: state.activeTable.table,
        updates,
      },
    });
  }

  function deleteSelectedRows() {
    if (!state.activeTable || state.selectedRowKeys.size === 0) {
      showStatus('Select at least one row to delete.', true);
      return;
    }

    const keys = selectedRowObjects();
    if (keys.length === 0) {
      showStatus('Selected rows do not have row keys.', true);
      return;
    }

    if (!confirm(`Delete ${keys.length} selected row(s)?`)) {
      return;
    }

    sendRequest('deleteRows', {
      payload: {
        schema: state.activeTable.schema,
        table: state.activeTable.table,
        keys,
      },
    });
  }

  function duplicateSelectedRow() {
    if (!state.activeTable) {
      return;
    }

    const keys = [...state.selectedRowKeys];
    if (keys.length !== 1) {
      showStatus('Select exactly one row to duplicate.', true);
      return;
    }

    const sourceRow = state.activeTable.rows.find((row) => rowKeyString(row.key) === keys[0]);
    if (!sourceRow) {
      showStatus('Unable to find selected row.', true);
      return;
    }

    sendRequest('duplicateRow', {
      row: sourceRow,
    });
  }

  function openAddRowModal() {
    if (!state.activeTable) {
      return;
    }

    elements.rowForm.innerHTML = '';
    const columns = state.activeTable.info.columns.filter((column) => !column.isAutoIncrement);

    if (columns.length === 0) {
      showStatus('No writable columns available for inserts.', true);
      return;
    }

    for (const column of columns) {
      const row = document.createElement('label');
      row.className = 'rowModalField';
      row.innerHTML = `${escapeHtml(column.name)}<input data-column="${escapeHtml(column.name)}" placeholder="${
        column.nullable ? 'NULL' : ''
      }" />`;
      elements.rowForm.appendChild(row);
    }

    elements.rowModal.hidden = false;
  }

  function closeAddRowModal() {
    elements.rowModal.hidden = true;
  }

  function submitAddRow() {
    if (!state.activeTable) {
      return;
    }

    const values = {};

    for (const input of elements.rowForm.querySelectorAll('input[data-column]')) {
      const columnName = input.dataset.column;
      const column = getColumnByName(columnName);
      if (!column) {
        continue;
      }

      const parsed = parseInputToScalar(input.value, column);
      if (parsed === null && input.value === '' && column.nullable) {
        values[columnName] = null;
      } else if (input.value !== '') {
        values[columnName] = parsed;
      }
    }

    sendRequest('insertRow', {
      payload: {
        schema: state.activeTable.schema,
        table: state.activeTable.table,
        values,
      },
    });

    closeAddRowModal();
  }

  function renderDdl() {
    elements.ddlTitle.textContent = state.ddl.title ? `DDL: ${state.ddl.title}` : 'DDL Viewer';
    elements.ddlOutput.textContent = state.ddl.text || 'Click "View DDL" to load the current object definition.';

    const hasDdl = Boolean(state.ddl.text);
    elements.btnCopyDdl.disabled = !hasDdl;
    elements.btnOpenDdl.disabled = !hasDdl;
  }

  function selectedRowObjects() {
    if (!state.activeTable) {
      return [];
    }

    const keys = [];
    for (const row of state.activeTable.rows) {
      const serialized = rowKeyString(row.key);
      if (serialized && state.selectedRowKeys.has(serialized) && row.key) {
        keys.push(row.key);
      }
    }
    return keys;
  }

  function rowKeyString(rowKey) {
    if (!rowKey) {
      return '';
    }

    return JSON.stringify(rowKey);
  }

  function getColumnByName(name) {
    if (!state.activeTable) {
      return undefined;
    }

    return state.activeTable.info.columns.find((column) => column.name === name);
  }

  function parseInputToScalar(rawInput, column) {
    const text = rawInput.trim();

    if (text.length === 0) {
      return column && column.nullable ? null : rawInput;
    }

    if (text.toUpperCase() === 'NULL') {
      return null;
    }

    const lowerType = (column && column.dataType ? column.dataType : '').toLowerCase();
    if (/(int|decimal|numeric|real|float|double)/.test(lowerType)) {
      const num = Number(text);
      if (!Number.isNaN(num)) {
        return num;
      }
    }

    if (/(bool)/.test(lowerType)) {
      if (text === '1' || text.toLowerCase() === 'true') {
        return true;
      }
      if (text === '0' || text.toLowerCase() === 'false') {
        return false;
      }
    }

    return rawInput;
  }

  function scalarToText(value) {
    if (value === null || value === undefined) {
      return 'NULL';
    }

    if (typeof value === 'object') {
      return JSON.stringify(value);
    }

    return String(value);
  }

  function scalarEquals(a, b) {
    if (a === b) {
      return true;
    }

    return String(a) === String(b);
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

  function escapeHtml(value) {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
})();
