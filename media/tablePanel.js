import { TabulatorFull as Tabulator } from 'tabulator-tables';
import '@vscode/codicons/dist/codicon.css';
import 'tabulator-tables/dist/css/tabulator.min.css';
import './tabulator-vscode.css';
import { getVsCodeApi } from './vscodeApi.js';

(() => {
  const vscode = getVsCodeApi();

  const state = {
    activeTable: null,
    pendingEdits: new Map(),
    ddl: {
      title: '',
      text: '',
      objectType: 'table',
    },
    tabulator: null,
    gridSignature: null,
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
          <button id="btnRefreshTable" class="iconBtn" title="Refresh" aria-label="Refresh"><i class="codicon codicon-refresh" aria-hidden="true"></i></button>
          <button id="btnExportTable" class="secondary hasIcon" disabled><i class="codicon codicon-desktop-download" aria-hidden="true"></i>Export</button>
          <button id="btnViewDdl" class="secondary hasIcon" disabled><i class="codicon codicon-code" aria-hidden="true"></i>DDL</button>
        </div>
      </div>

      <div id="tableWarning" class="warning" hidden></div>

      <div class="gridSection">
        <div id="tableControls" hidden>
          <div class="gridToolbar">
            <button id="btnAddRow" class="hasIcon"><i class="codicon codicon-add" aria-hidden="true"></i>Row</button>
            <button id="btnDuplicateRow" class="iconBtn" title="Duplicate selected row" aria-label="Duplicate selected row" disabled><i class="codicon codicon-copy" aria-hidden="true"></i></button>
            <button id="btnDeleteRows" class="iconBtn danger" title="Delete selected rows" aria-label="Delete selected rows" disabled><i class="codicon codicon-trash" aria-hidden="true"></i></button>

            <span class="toolbarDivider" aria-hidden="true"></span>

            <button id="btnToggleFilter" class="secondary hasIcon" aria-pressed="false"><i class="codicon codicon-filter" aria-hidden="true"></i>Filter</button>
            <span id="filterChips" class="filterChips"></span>

            <div class="findBox">
              <i class="codicon codicon-search" aria-hidden="true"></i>
              <input id="findInPage" placeholder="Find in page" />
            </div>

            <span class="spacer"></span>

            <button id="btnShowAllCols" class="iconBtn" title="Show all columns" aria-label="Show all columns"><i class="codicon codicon-eye" aria-hidden="true"></i></button>
            <select id="pageSize" class="compactSelect" title="Page size" aria-label="Page size">
              <option value="25">25</option>
              <option value="50" selected>50</option>
              <option value="100">100</option>
              <option value="250">250</option>
            </select>
            <button id="btnPrevPage" class="iconBtn" title="Previous page" aria-label="Previous page"><i class="codicon codicon-chevron-left" aria-hidden="true"></i></button>
            <button id="btnNextPage" class="iconBtn" title="Next page" aria-label="Next page"><i class="codicon codicon-chevron-right" aria-hidden="true"></i></button>
            <span id="pageInfo" class="muted"></span>
          </div>

          <div id="filterBar" class="filterBar" hidden>
            <label>Column
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
            <label class="filterValueField">Value
              <input id="filterValue" placeholder="filter value" />
            </label>
            <button id="btnAddFilter" class="secondary">Add filter</button>
            <label class="whereField">Raw WHERE
              <input id="whereInput" placeholder="e.g. account_role = 'Owner' and events_count = 1" />
            </label>
            <button id="btnApplyFilter" class="secondary">Apply WHERE</button>
            <button id="btnClearFilter" class="secondary">Clear all</button>
            <span class="filterHint muted">Filters combine with AND (including the raw WHERE) — click a chip to remove it. Shift-click a header to sort by multiple columns.</span>
          </div>

          <div id="editBar" class="editBar" hidden>
            <i class="codicon codicon-edit" aria-hidden="true"></i>
            <span id="editInfo">0 pending changes</span>
            <span class="spacer"></span>
            <button id="btnCancelEdits" class="secondary">Revert</button>
            <button id="btnApplyEdits">Submit</button>
          </div>
        </div>

        <div id="tableGridWrap" class="gridWrap"></div>
        <div id="aggregateStrip" class="aggregate muted"></div>
      </div>

      <section id="ddlSection" class="panel" hidden>
        <div class="panelHeader">
          <h2 id="ddlTitle">DDL</h2>
          <div class="inlineButtons">
            <button id="btnCopyDdl" class="secondary" disabled>Copy</button>
            <button id="btnOpenDdl" class="secondary" disabled>Open in editor</button>
            <button id="btnCloseDdl" class="iconBtn" title="Hide DDL" aria-label="Hide DDL"><i class="codicon codicon-close" aria-hidden="true"></i></button>
          </div>
        </div>
        <pre id="ddlOutput" class="ddl"></pre>
      </section>

      <div id="statusBar" class="status"></div>
    </div>

    <div id="rowModal" class="modal" hidden>
      <div class="modalContent">
        <div class="panelHeader">
          <h2>Add row</h2>
          <button id="btnCloseRowModal" class="secondary">Close</button>
        </div>
        <form id="rowForm"></form>
        <div class="actions">
          <button id="btnSubmitRow" type="button">Insert row</button>
        </div>
      </div>
    </div>

    <div id="valueModal" class="modal" hidden>
      <div class="modalContent">
        <div class="panelHeader">
          <h2 id="valueModalTitle">Value</h2>
          <div class="inlineButtons">
            <button id="btnCopyValue" class="secondary">Copy</button>
            <button id="btnCloseValueModal" class="secondary">Close</button>
          </div>
        </div>
        <pre id="valueModalBody" class="ddl"></pre>
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
    btnShowAllCols: document.getElementById('btnShowAllCols'),
    filterColumn: document.getElementById('filterColumn'),
    filterOperator: document.getElementById('filterOperator'),
    filterValue: document.getElementById('filterValue'),
    whereInput: document.getElementById('whereInput'),
    btnAddFilter: document.getElementById('btnAddFilter'),
    btnApplyFilter: document.getElementById('btnApplyFilter'),
    btnClearFilter: document.getElementById('btnClearFilter'),
    btnExportTable: document.getElementById('btnExportTable'),
    btnAddRow: document.getElementById('btnAddRow'),
    btnDuplicateRow: document.getElementById('btnDuplicateRow'),
    btnDeleteRows: document.getElementById('btnDeleteRows'),
    editInfo: document.getElementById('editInfo'),
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
    findInPage: document.getElementById('findInPage'),
    aggregateStrip: document.getElementById('aggregateStrip'),
    valueModal: document.getElementById('valueModal'),
    valueModalTitle: document.getElementById('valueModalTitle'),
    valueModalBody: document.getElementById('valueModalBody'),
    btnCopyValue: document.getElementById('btnCopyValue'),
    btnCloseValueModal: document.getElementById('btnCloseValueModal'),
    btnToggleFilter: document.getElementById('btnToggleFilter'),
    filterChips: document.getElementById('filterChips'),
    filterBar: document.getElementById('filterBar'),
    editBar: document.getElementById('editBar'),
    ddlSection: document.getElementById('ddlSection'),
    btnCloseDdl: document.getElementById('btnCloseDdl'),
  };

  elements.btnRefreshTable.addEventListener('click', () => sendRequest('refreshTable'));
  elements.btnPrevPage.addEventListener('click', () => changePage(-1));
  elements.btnNextPage.addEventListener('click', () => changePage(1));
  elements.btnShowAllCols.addEventListener('click', () => {
    if (state.tabulator) {
      for (const column of state.tabulator.getColumns()) {
        column.show();
      }
    }
  });
  elements.btnToggleFilter.addEventListener('click', () => {
    const show = elements.filterBar.hidden;
    elements.filterBar.hidden = !show;
    elements.btnToggleFilter.setAttribute('aria-pressed', String(show));
  });
  elements.btnExportTable.addEventListener('click', () => {
    if (!state.activeTable) {
      return;
    }
    sendRequest('exportTable', { selection: getSelectedOriginalRows() });
  });
  elements.btnCloseDdl.addEventListener('click', () => {
    elements.ddlSection.hidden = true;
  });
  elements.pageSize.addEventListener('change', () => {
    if (!state.activeTable) {
      return;
    }

    state.activeTable.pageSize = Number(elements.pageSize.value);
    state.activeTable.page = 0;
    queryActiveTable();
  });

  elements.btnAddFilter.addEventListener('click', () => addFilterFromInputs());
  elements.filterValue.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      addFilterFromInputs();
    }
  });

  elements.btnApplyFilter.addEventListener('click', () => applyRawWhere());
  elements.whereInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      applyRawWhere();
    }
  });

  elements.btnClearFilter.addEventListener('click', () => clearAllFilters());

  elements.btnApplyEdits.addEventListener('click', () => applyPendingEdits());
  elements.btnCancelEdits.addEventListener('click', () => cancelEdits());

  elements.btnAddRow.addEventListener('click', () => openAddRowModal());
  elements.btnCloseRowModal.addEventListener('click', () => closeAddRowModal());
  elements.btnSubmitRow.addEventListener('click', () => submitAddRow());
  elements.btnDuplicateRow.addEventListener('click', () => duplicateSelectedRow());
  elements.btnDeleteRows.addEventListener('click', () => deleteSelectedRows());
  elements.findInPage.addEventListener('input', () => applyFindFilter());
  elements.btnCloseValueModal.addEventListener('click', () => {
    elements.valueModal.hidden = true;
  });
  elements.btnCopyValue.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(elements.valueModalBody.textContent || '');
      showStatus('Value copied to clipboard.');
    } catch (error) {
      showStatus('Copy failed.', true);
      console.error(error);
    }
  });

  elements.btnViewDdl.addEventListener('click', () => {
    if (!state.activeTable) {
      return;
    }

    elements.ddlSection.hidden = false;
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
          filters: message.filters,
          where: message.where,
          info: message.info,
          rows: message.rows,
          totalCount: message.totalCount,
        };
        elements.pageSize.value = String(message.pageSize);
        elements.whereInput.value = message.where || '';
        state.pendingEdits.clear();
        renderMeta();
        renderGrid();
        populateFilterColumns();
        renderFilterChips();
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

  const OP_LABELS = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    contains: 'contains',
    startsWith: 'starts with',
    endsWith: 'ends with',
    isNull: 'is null',
    isNotNull: 'is not null',
  };

  function populateFilterColumns() {
    const previous = elements.filterColumn.value;
    elements.filterColumn.innerHTML = '';
    if (!state.activeTable) {
      return;
    }

    for (const column of state.activeTable.info.columns) {
      const option = document.createElement('option');
      option.value = column.name;
      option.textContent = column.name;
      elements.filterColumn.appendChild(option);
    }

    const names = state.activeTable.info.columns.map((column) => column.name);
    elements.filterColumn.value = names.includes(previous) ? previous : names[0] || '';
  }

  function addFilterFromInputs() {
    if (!state.activeTable) {
      return;
    }

    const column = elements.filterColumn.value;
    if (!column) {
      return;
    }

    const operator = elements.filterOperator.value;
    const filter = { column, operator };

    if (operator !== 'isNull' && operator !== 'isNotNull') {
      if (!elements.filterValue.value.trim()) {
        showStatus('Enter a value for the filter.', true);
        return;
      }
      filter.value = parseInputToScalar(elements.filterValue.value, getColumnByName(column));
    }

    elements.filterValue.value = '';
    appendFilter(filter);
  }

  function appendFilter(filter) {
    const filters = Array.isArray(state.activeTable.filters) ? state.activeTable.filters.slice() : [];
    const duplicate = filters.some(
      (existing) =>
        existing.column === filter.column &&
        existing.operator === filter.operator &&
        String(existing.value ?? '') === String(filter.value ?? ''),
    );
    if (!duplicate) {
      filters.push(filter);
    }

    state.activeTable.filters = filters;
    state.activeTable.page = 0;
    queryActiveTable();
  }

  function removeFilterAt(index) {
    const filters = (state.activeTable.filters || []).slice();
    filters.splice(index, 1);
    state.activeTable.filters = filters.length ? filters : undefined;
    state.activeTable.page = 0;
    queryActiveTable();
  }

  function applyRawWhere() {
    if (!state.activeTable) {
      return;
    }

    state.activeTable.where = elements.whereInput.value.trim() || undefined;
    state.activeTable.page = 0;
    queryActiveTable();
  }

  function clearAllFilters() {
    if (!state.activeTable) {
      return;
    }
    state.activeTable.filters = undefined;
    state.activeTable.where = undefined;
    elements.filterValue.value = '';
    elements.whereInput.value = '';
    state.activeTable.page = 0;
    queryActiveTable();
  }

  function renderFilterChips() {
    elements.filterChips.innerHTML = '';
    const active = state.activeTable;
    if (!active) {
      return;
    }

    (active.filters || []).forEach((filter, index) => {
      const opText = OP_LABELS[filter.operator] || filter.operator;
      const valueText =
        filter.operator === 'isNull' || filter.operator === 'isNotNull' ? '' : ` ${filter.value ?? ''}`;
      appendChip(`${filter.column} ${opText}${valueText}`, 'Remove this filter', () => removeFilterAt(index));
    });

    if (active.where) {
      appendChip(`WHERE ${active.where}`, 'Remove the raw WHERE', () => {
        active.where = undefined;
        elements.whereInput.value = '';
        active.page = 0;
        queryActiveTable();
      });
    }
  }

  function appendChip(text, title, onRemove) {
    const chip = document.createElement('button');
    chip.className = 'filterChip';
    chip.title = title;
    chip.textContent = `${text}  ✕`;
    chip.addEventListener('click', onRemove);
    elements.filterChips.appendChild(chip);
  }

  function renderMeta() {
    if (!state.activeTable) {
      elements.tableTitle.textContent = 'Loading table…';
      elements.tableMeta.textContent = 'Waiting for database rows.';
      elements.tableControls.hidden = true;
      elements.btnViewDdl.disabled = true;
      elements.btnExportTable.disabled = true;
      elements.tableWarning.hidden = true;
      elements.pageInfo.textContent = '';
      return;
    }

    const active = state.activeTable;
    elements.tableTitle.textContent = `${active.info.schema}.${active.info.name}`;
    elements.tableControls.hidden = false;
    elements.btnViewDdl.disabled = false;
    elements.btnExportTable.disabled = false;

    const start = active.page * active.pageSize + 1;
    const end = active.page * active.pageSize + active.rows.length;
    const total = active.totalCount !== undefined ? active.totalCount : '?';
    elements.pageInfo.textContent = active.rows.length
      ? `Rows ${start}-${end} of ${total}`
      : `No rows. Total ${total}`;
    elements.tableMeta.textContent = `${active.info.objectType.toUpperCase()} • ${active.info.columns.length} columns`;

    elements.btnPrevPage.disabled = active.page <= 0;
    elements.btnNextPage.disabled =
      typeof active.totalCount === 'number'
        ? (active.page + 1) * active.pageSize >= active.totalCount
        : active.rows.length < active.pageSize;

    if (active.info.readOnly) {
      elements.tableWarning.hidden = false;
      elements.tableWarning.textContent = active.info.readOnlyReason || 'Read-only object.';
    } else {
      elements.tableWarning.hidden = true;
      elements.tableWarning.textContent = '';
    }

    elements.btnAddRow.disabled = active.info.readOnly;
    updateEditInfo();
    updateSelectionButtons();
  }

  function gridSignature(active) {
    // Everything the column definitions (and their closures) are derived from.
    // Sort is included because the header titles render sort arrows.
    return JSON.stringify([
      active.info.schema,
      active.info.name,
      active.info.readOnly,
      active.info.writableKey.columns,
      active.info.columns.map((column) => [
        column.name,
        column.dataType,
        column.isPrimaryKey,
        column.isUniqueKey,
        column.isAutoIncrement,
      ]),
      active.sort ?? [],
    ]);
  }

  function renderGrid() {
    const active = state.activeTable;
    if (!active) {
      return;
    }

    const signature = gridSignature(active);
    if (state.tabulator && state.gridSignature === signature) {
      // Same columns and sort: swap the data in place so column widths, order,
      // visibility, and scroll position survive paging, refreshes, and edits.
      state.tabulator
        .replaceData(buildData(active))
        .then(() => {
          updateSelectionButtons();
          updateAggregateStrip();
          applyFindFilter();
        })
        .catch((error) => console.error(error));
      return;
    }

    state.gridSignature = signature;

    if (state.tabulator) {
      try {
        state.tabulator.destroy();
      } catch (error) {
        console.error(error);
      }
      state.tabulator = null;
    }

    const table = new Tabulator(elements.tableGridWrap, {
      data: buildData(active),
      columns: buildColumns(active),
      index: '_dbx_i',
      layout: 'fitDataStretch',
      height: '100%',
      movableColumns: true,
      selectableRows: active.info.readOnly ? false : true,
      placeholder: 'No rows.',
      reactiveData: false,
      rowHeight: 28,
      columnDefaults: { resizable: true, headerSort: false },
    });

    table.on('tableBuilt', () => {
      updateSelectionButtons();
      updateAggregateStrip();
      applyFindFilter();
    });
    table.on('rowSelectionChanged', () => {
      updateSelectionButtons();
      updateAggregateStrip();
    });

    state.tabulator = table;
  }

  function buildData(active) {
    return active.rows.map((row, index) => {
      const item = { _dbx_i: index };
      for (const column of active.info.columns) {
        item[column.name] = row.values[column.name];
      }
      return item;
    });
  }

  function buildColumns(active) {
    const columns = [];

    if (!active.info.readOnly) {
      columns.push({
        formatter: 'rowSelection',
        titleFormatter: 'rowSelection',
        titleFormatterParams: { rowRange: 'active' },
        hozAlign: 'center',
        headerHozAlign: 'center',
        headerSort: false,
        width: 34,
        minWidth: 34,
        frozen: true,
        resizable: false,
        cssClass: 'dbx-select-col',
      });
    }

    for (const column of active.info.columns) {
      columns.push({
        title: column.name,
        field: column.name,
        headerSort: false,
        minWidth: 80,
        hozAlign: columnIsNumeric(column) ? 'right' : 'left',
        headerTooltip: columnTooltip(column),
        titleFormatter: () => titleHtml(column, active),
        formatter: nullableFormatter,
        editor: 'input',
        editable: (cell) => {
          if (!cellEditable(active, column)) {
            return false;
          }
          const row = originalRow(cell);
          return Boolean(row && row.key);
        },
        cellEdited: (cell) => handleCellEdited(active, column, cell),
        headerClick: (event) => toggleSort(column.name, event.shiftKey),
        headerMenu: buildHeaderMenu(),
        contextMenu: buildCellMenu(),
      });
    }

    return columns;
  }

  function titleHtml(column, active) {
    const sort = Array.isArray(active.sort) ? active.sort : [];
    const index = sort.findIndex((spec) => spec.column === column.name);
    const flags = [];
    if (column.isPrimaryKey) {
      flags.push('PK');
    } else if (column.isUniqueKey) {
      flags.push('UQ');
    }
    const flagHtml = flags.length ? ` <span class="dbx-col-flag">${flags.join(' ')}</span>` : '';
    let arrowHtml = '';
    if (index !== -1) {
      const arrow = sort[index].direction === 'asc' ? '▲' : '▼';
      const order = sort.length > 1 ? `<span class="dbx-sort-order">${index + 1}</span>` : '';
      arrowHtml = ` <span class="dbx-sort">${arrow}${order}</span>`;
    }
    return `<span class="dbx-col-name">${escapeHtml(column.name)}</span>${flagHtml}${arrowHtml}`;
  }

  function columnTooltip(column) {
    const parts = [column.dataType || 'unknown'];
    parts.push(column.nullable ? 'NULL' : 'NOT NULL');
    if (column.isPrimaryKey) {
      parts.push('primary key');
    } else if (column.isUniqueKey) {
      parts.push('unique');
    }
    if (column.isAutoIncrement) {
      parts.push('auto-increment');
    }
    return `${column.name} — ${parts.join(' · ')}`;
  }

  function nullableFormatter(cell) {
    const value = cell.getValue();
    if (value === null || value === undefined) {
      return '<span class="dbx-null">NULL</span>';
    }
    return escapeHtml(String(value));
  }

  function buildHeaderMenu() {
    return [
      {
        label: 'Hide column',
        action: (event, column) => column.hide(),
      },
      {
        label: 'Freeze / unfreeze column',
        action: (event, column) => {
          try {
            const definition = column.getDefinition();
            column.updateDefinition(Object.assign({}, definition, { frozen: !definition.frozen }));
          } catch (error) {
            showStatus('Column freezing is not available for this column.', true);
            console.error(error);
          }
        },
      },
    ];
  }

  function cellEditable(active, column) {
    if (active.info.readOnly) {
      return false;
    }
    if (column.isAutoIncrement) {
      return false;
    }
    if (active.info.writableKey.columns.includes(column.name)) {
      return false;
    }
    return true;
  }

  function originalRow(cell) {
    if (!state.activeTable) {
      return undefined;
    }
    const data = cell.getRow().getData();
    return state.activeTable.rows[data._dbx_i];
  }

  function handleCellEdited(active, column, cell) {
    const row = originalRow(cell);
    if (!row) {
      return;
    }

    onCellEdit(row, column, cell.getValue());

    const key = rowKeyString(row.key);
    const edit = key ? state.pendingEdits.get(key) : undefined;
    const changed = Boolean(edit && Object.prototype.hasOwnProperty.call(edit.changes, column.name));
    cell.getElement().classList.toggle('dbx-cell-edited', changed);

    updateEditInfo();
  }

  function onCellEdit(row, column, rawInput) {
    if (!row.key || !column) {
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

  function updateEditInfo() {
    const count = state.pendingEdits.size;
    const readOnly = !state.activeTable || state.activeTable.info.readOnly;
    elements.editInfo.textContent = `${count} pending change${count === 1 ? '' : 's'}`;
    elements.editBar.hidden = readOnly || count === 0;
  }

  function updateSelectionButtons() {
    const active = state.activeTable;
    const readOnly = !active || active.info.readOnly;
    const selected = getSelectedOriginalRows();
    elements.btnDeleteRows.disabled = readOnly || selected.length === 0;
    elements.btnDuplicateRow.disabled = readOnly || selected.length !== 1;
  }

  function getSelectedOriginalRows() {
    if (!state.tabulator || !state.activeTable) {
      return [];
    }
    try {
      return state.tabulator
        .getSelectedData()
        .map((data) => state.activeTable.rows[data._dbx_i])
        .filter(Boolean);
    } catch (error) {
      return [];
    }
  }

  function buildCellMenu() {
    return [
      { label: 'View value', action: (event, cell) => openValueViewer(cell) },
      { label: 'Copy value', action: (event, cell) => copyCellValue(cell) },
      { label: 'Filter by this value', action: (event, cell) => filterByCell(cell) },
    ];
  }

  function openValueViewer(cell) {
    elements.valueModalTitle.textContent = `Value · ${cell.getColumn().getField()}`;
    elements.valueModalBody.textContent = formatValueForViewer(cell.getValue());
    elements.valueModal.hidden = false;
  }

  function formatValueForViewer(value) {
    if (value === null || value === undefined) {
      return 'NULL';
    }
    const str = String(value);
    const trimmed = str.trim();
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksJson) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch (error) {
        return str;
      }
    }
    return str;
  }

  async function copyCellValue(cell) {
    const value = cell.getValue();
    try {
      await navigator.clipboard.writeText(value === null || value === undefined ? '' : String(value));
      showStatus('Cell value copied.');
    } catch (error) {
      showStatus('Copy failed.', true);
      console.error(error);
    }
  }

  function filterByCell(cell) {
    if (!state.activeTable) {
      return;
    }
    const columnName = cell.getColumn().getField();
    const value = cell.getValue();
    // Appends to the active filters so repeated right-clicks drill down.
    appendFilter(
      value === null || value === undefined
        ? { column: columnName, operator: 'isNull' }
        : { column: columnName, operator: 'eq', value },
    );
  }

  function applyFindFilter() {
    if (!state.tabulator) {
      return;
    }
    const term = elements.findInPage.value.trim().toLowerCase();
    if (!term) {
      state.tabulator.clearFilter(true);
      return;
    }
    state.tabulator.setFilter((data) => {
      for (const key in data) {
        if (key === '_dbx_i') {
          continue;
        }
        const value = data[key];
        if (value !== null && value !== undefined && String(value).toLowerCase().includes(term)) {
          return true;
        }
      }
      return false;
    });
  }

  function updateAggregateStrip() {
    const active = state.activeTable;
    if (!active) {
      elements.aggregateStrip.textContent = '';
      return;
    }

    const selected = getSelectedOriginalRows();
    const rows = selected.length ? selected : active.rows;
    const scope = selected.length ? `${selected.length} selected` : `${active.rows.length} loaded`;
    const parts = [`Rows: ${scope}`];

    for (const column of active.info.columns) {
      if (!columnIsNumeric(column) || column.isPrimaryKey || column.isAutoIncrement) {
        continue;
      }
      const numbers = rows
        .map((row) => row.values[column.name])
        .filter((value) => value !== null && value !== undefined && value !== '' && !Number.isNaN(Number(value)))
        .map(Number);
      if (numbers.length === 0) {
        continue;
      }
      const sum = numbers.reduce((total, value) => total + value, 0);
      const avg = sum / numbers.length;
      parts.push(
        `${column.name}: Σ ${formatAggregate(sum)} · x̄ ${formatAggregate(avg)} · ↓ ${formatAggregate(
          Math.min(...numbers),
        )} · ↑ ${formatAggregate(Math.max(...numbers))}`,
      );
    }

    elements.aggregateStrip.textContent = parts.join('     ');
  }

  function formatAggregate(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  function toggleSort(column, additive) {
    if (!state.activeTable || !column) {
      return;
    }

    const current = Array.isArray(state.activeTable.sort) ? state.activeTable.sort.slice() : [];
    const index = current.findIndex((spec) => spec.column === column);

    let next;
    if (additive) {
      next = current;
      if (index === -1) {
        next.push({ column, direction: 'asc' });
      } else if (next[index].direction === 'asc') {
        next[index] = { column, direction: 'desc' };
      } else {
        next.splice(index, 1);
      }
    } else if (index === -1 || current.length !== 1) {
      next = [{ column, direction: 'asc' }];
    } else if (current[0].direction === 'asc') {
      next = [{ column, direction: 'desc' }];
    } else {
      next = [];
    }

    state.activeTable.sort = next.length ? next : undefined;
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
      filters: state.activeTable.filters,
      where: state.activeTable.where,
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

  function cancelEdits() {
    state.pendingEdits.clear();
    if (state.tabulator && state.activeTable) {
      state.tabulator.setData(buildData(state.activeTable));
    }
    updateEditInfo();
  }

  function deleteSelectedRows() {
    const rows = getSelectedOriginalRows();
    if (rows.length === 0) {
      showStatus('Select at least one row to delete.', true);
      return;
    }

    const keys = rows.filter((row) => row.key).map((row) => row.key);
    if (keys.length === 0) {
      showStatus('Selected rows do not have row keys.', true);
      return;
    }

    // Confirmation happens host-side via a native modal — webview confirm() is
    // blocked in the VS Code webview sandbox.
    sendRequest('deleteRows', {
      payload: {
        schema: state.activeTable.schema,
        table: state.activeTable.table,
        keys,
      },
    });
  }

  function duplicateSelectedRow() {
    const rows = getSelectedOriginalRows();
    if (rows.length !== 1) {
      showStatus('Select exactly one row to duplicate.', true);
      return;
    }

    sendRequest('duplicateRow', {
      row: rows[0],
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
    elements.ddlTitle.textContent = state.ddl.title ? `DDL · ${state.ddl.title}` : 'DDL';
    elements.ddlOutput.textContent = state.ddl.text || 'Loading…';

    const hasDdl = Boolean(state.ddl.text);
    elements.btnCopyDdl.disabled = !hasDdl;
    elements.btnOpenDdl.disabled = !hasDdl;
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

  function columnIsNumeric(column) {
    const lowerType = (column && column.dataType ? column.dataType : '').toLowerCase();
    return /(int|decimal|numeric|real|float|double|bigint)/.test(lowerType);
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
