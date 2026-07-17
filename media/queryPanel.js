import { TabulatorFull as Tabulator } from 'tabulator-tables';
import '@vscode/codicons/dist/codicon.css';
import 'tabulator-tables/dist/css/tabulator.min.css';
import './tabulator-vscode.css';
import { getVsCodeApi } from './vscodeApi.js';
import { expandNowKeyword, parseInputToScalar, scalarEquals } from './valueParsing.js';

(() => {
  const vscode = getVsCodeApi();

  const state = {
    dialect: '',
    connectionName: '',
    running: false,
    hideEditor: false,
    grids: [],
    // Edit controller whose Submit round-trip is in flight (single-writer:
    // the button disables itself until the host answers).
    pendingSubmit: null,
  };

  let requestCounter = 0;

  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="root queryRoot" id="queryRoot">
      <div class="toolbar">
        <div class="toolbarTitle">
          <h1 id="queryTitle">Query <span id="envBadge" class="envBadge" hidden></span></h1>
          <div id="queryMeta" class="muted">Connecting…</div>
        </div>
        <div class="inlineButtons" id="editorButtons">
          <button id="btnQueryHistory" class="iconBtn" title="Query history" aria-label="Query history"><i class="codicon codicon-history" aria-hidden="true"></i></button>
          <button id="btnExplain" class="secondary hasIcon" disabled title="Run EXPLAIN for the script or selection"><i class="codicon codicon-pulse" aria-hidden="true"></i>Explain</button>
          <button id="btnRunQuery" class="hasIcon" disabled><i class="codicon codicon-play" aria-hidden="true"></i>Run</button>
        </div>
      </div>

      <textarea id="sqlInput" class="sqlEditor" spellcheck="false" placeholder="SELECT * FROM …"></textarea>
      <div id="queryHint" class="queryHint">⌘/Ctrl+Enter runs the script — or just the selected text when there is a selection.</div>

      <div id="queryResults" class="queryResults"></div>

      <div id="statusBar" class="status"></div>
    </div>
  `;

  const elements = {
    queryRoot: document.getElementById('queryRoot'),
    queryTitle: document.getElementById('queryTitle'),
    queryMeta: document.getElementById('queryMeta'),
    envBadge: document.getElementById('envBadge'),
    editorButtons: document.getElementById('editorButtons'),
    btnQueryHistory: document.getElementById('btnQueryHistory'),
    btnExplain: document.getElementById('btnExplain'),
    btnRunQuery: document.getElementById('btnRunQuery'),
    sqlInput: document.getElementById('sqlInput'),
    queryHint: document.getElementById('queryHint'),
    queryResults: document.getElementById('queryResults'),
    statusBar: document.getElementById('statusBar'),
  };

  elements.btnRunQuery.addEventListener('click', () => runQuery());
  elements.btnExplain.addEventListener('click', () => runQuery({ explain: true }));
  elements.btnQueryHistory.addEventListener('click', () => sendRequest('pickQueryHistory'));
  elements.sqlInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      runQuery();
    }
  });

  window.addEventListener('message', (event) => {
    handleEvent(event.data);
  });

  sendRequest('ready');

  function handleEvent(message) {
    switch (message.kind) {
      case 'queryConfig':
        state.dialect = message.dialect;
        state.connectionName = message.connectionName;
        state.hideEditor = Boolean(message.hideEditor);
        elements.queryTitle.firstChild.textContent = `${state.hideEditor ? 'Results' : 'Query'} · ${message.connectionName} `;
        elements.queryMeta.textContent = message.dialect.toUpperCase();
        applyEnvironment(message.environment);
        // Results-only panels (bound .sql editors) have no inline editor: the
        // SQL lives in the real document.
        elements.sqlInput.hidden = state.hideEditor;
        elements.queryHint.hidden = state.hideEditor;
        elements.editorButtons.hidden = state.hideEditor;
        elements.btnRunQuery.disabled = false;
        elements.btnExplain.disabled = false;
        if (!state.hideEditor) {
          elements.sqlInput.focus();
        }
        break;

      case 'insertSql':
        elements.sqlInput.value = message.sql;
        elements.sqlInput.focus();
        elements.sqlInput.setSelectionRange(message.sql.length, message.sql.length);
        break;

      case 'queryResults':
        setRunning(false);
        state.pendingSubmit = null;
        renderResults(message.results, message.editable || []);
        showStatus(
          `${message.results.length} statement${message.results.length === 1 ? '' : 's'} executed.`,
        );
        break;

      case 'mutationApplied':
        showStatus(message.message);
        if (state.pendingSubmit) {
          state.pendingSubmit.commit();
          state.pendingSubmit = null;
        }
        break;

      case 'info':
        showStatus(message.message);
        break;

      case 'error':
        setRunning(false);
        showStatus(message.message, true);
        if (state.pendingSubmit) {
          // Keep the staged edits so the user can fix the problem and retry.
          state.pendingSubmit.fail();
          state.pendingSubmit = null;
        }
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

  function runQuery(options = {}) {
    if (state.running) {
      return;
    }

    const { selectionStart, selectionEnd, value } = elements.sqlInput;
    let sql = (selectionStart !== selectionEnd ? value.slice(selectionStart, selectionEnd) : value).trim();
    if (!sql) {
      showStatus('Nothing to run — the editor is empty.', true);
      return;
    }

    if (options.explain) {
      // SQLite answers EXPLAIN with opcodes; QUERY PLAN is the readable form.
      sql = `${state.dialect === 'sqlite' ? 'EXPLAIN QUERY PLAN' : 'EXPLAIN'} ${sql}`;
    }

    setRunning(true);
    showStatus('Running…');
    sendRequest('runQuery', { sql });
  }

  function setRunning(running) {
    state.running = running;
    elements.btnRunQuery.disabled = running || !state.connectionName;
    elements.btnExplain.disabled = running || !state.connectionName;
  }

  function applyEnvironment(environment) {
    if (environment) {
      elements.queryRoot.dataset.env = environment;
      elements.envBadge.hidden = false;
      elements.envBadge.className = `envBadge env-${environment}`;
      elements.envBadge.textContent = environment === 'prod' ? 'production' : environment;
    } else {
      delete elements.queryRoot.dataset.env;
      elements.envBadge.hidden = true;
    }
  }

  function renderResults(results, editableList) {
    for (const grid of state.grids) {
      try {
        grid.destroy();
      } catch (error) {
        console.error(error);
      }
    }
    state.grids = [];
    state.pendingSubmit = null;
    elements.queryResults.innerHTML = '';

    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No statements were executed.';
      elements.queryResults.appendChild(empty);
      return;
    }

    results.forEach((result, index) => {
      const section = document.createElement('section');
      section.className = 'resultSection';

      const meta = document.createElement('div');
      meta.className = 'resultMeta';

      if (result.columns.length > 0) {
        const editableInfo = editableList[index] || null;
        const editor = editableInfo ? createEditController(result, editableInfo) : null;

        meta.textContent =
          `Statement ${index + 1} · ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} · ` +
          `${result.durationMs}ms${editor ? ` · editable (${editableInfo.schema}.${editableInfo.table})` : ''}`;

        const header = document.createElement('div');
        header.className = 'resultHeader';
        header.appendChild(meta);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'iconBtn';
        exportBtn.title = 'Export this result';
        exportBtn.setAttribute('aria-label', 'Export this result');
        exportBtn.innerHTML = '<i class="codicon codicon-desktop-download" aria-hidden="true"></i>';
        exportBtn.addEventListener('click', () => {
          sendRequest('exportResults', { statementIndex: index });
        });
        header.appendChild(exportBtn);

        section.appendChild(header);

        const gridWrap = document.createElement('div');
        section.appendChild(gridWrap);
        if (editor) {
          section.appendChild(editor.element);
        }
        elements.queryResults.appendChild(section);

        // Field keys are positional: column names may contain dots or repeat
        // (e.g. `count(*)`, joined tables), which Tabulator fields can't hold.
        const columns = result.columns.map((name, columnIndex) => {
          const columnMeta = editableInfo ? editableInfo.columns[columnIndex] : null;
          const definition = {
            title: name,
            titleFormatter: () => escapeHtml(name),
            field: `c${columnIndex}`,
            headerSort: true,
            minWidth: 80,
            formatter: nullableFormatter,
          };

          if (editor && columnMeta && columnMeta.editable) {
            definition.editor = 'input';
            definition.editable = (cell) => editor.rowHasKey(cell.getData()._i);
            definition.cellEdited = (cell) => editor.onCellEdited(cell, columnIndex, columnMeta);
            definition.contextMenu = (event, cell) => editor.buildMenu(cell, columnMeta);
          }

          return definition;
        });

        const grid = new Tabulator(gridWrap, {
          data: buildGridData(result),
          columns,
          index: '_i',
          layout: 'fitDataStretch',
          maxHeight: 320,
          placeholder: 'No rows.',
          reactiveData: false,
          rowHeight: 28,
          selectableRows: false,
          columnDefaults: { resizable: true },
        });
        if (editor) {
          editor.attachGrid(grid);
        }
        state.grids.push(grid);
      } else {
        const parts = [`Statement ${index + 1}`];
        parts.push(`${result.affectedRows ?? 0} row${(result.affectedRows ?? 0) === 1 ? '' : 's'} affected`);
        if (result.lastInsertId !== undefined && result.lastInsertId !== null && result.lastInsertId !== 0) {
          parts.push(`last insert id ${result.lastInsertId}`);
        }
        parts.push(`${result.durationMs}ms`);

        const summary = document.createElement('div');
        summary.className = 'resultSummary';
        summary.textContent = parts.join(' · ');
        section.appendChild(summary);
        elements.queryResults.appendChild(section);
      }
    });
  }

  function buildGridData(result) {
    return result.rows.map((row, rowIndex) => {
      const item = { _i: rowIndex };
      row.forEach((valueCell, columnIndex) => {
        item[`c${columnIndex}`] = valueCell;
      });
      return item;
    });
  }

  // Pending-edit state for one editable result set. Edits stage locally
  // (highlighted cells + an edit bar) and Submit sends them as keyed UPDATEs;
  // the result's own rows provide the key values, which stay original because
  // key columns are never editable.
  function createEditController(result, editableInfo) {
    const pending = new Map(); // rowIndex -> { [columnName]: parsedValue }
    const keyIndexes = editableInfo.keyColumns.map((keyName) => result.columns.indexOf(keyName));
    let grid = null;

    const bar = document.createElement('div');
    bar.className = 'editBar';
    bar.hidden = true;
    bar.innerHTML =
      '<i class="codicon codicon-edit" aria-hidden="true"></i>' +
      '<span class="qEditInfo">0 pending changes</span>' +
      '<span class="spacer"></span>';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'secondary';
    revertBtn.textContent = 'Revert';
    revertBtn.addEventListener('click', () => controller.revert());
    bar.appendChild(revertBtn);

    const submitBtn = document.createElement('button');
    submitBtn.textContent = 'Submit';
    submitBtn.addEventListener('click', () => controller.submit());
    bar.appendChild(submitBtn);

    const infoLabel = bar.querySelector('.qEditInfo');

    function updateBar() {
      const count = [...pending.values()].reduce((total, changes) => total + Object.keys(changes).length, 0);
      infoLabel.textContent = `${count} pending change${count === 1 ? '' : 's'}`;
      bar.hidden = count === 0;
    }

    function resetGridData() {
      if (grid) {
        // Rebuilding the rows also drops the per-cell edited highlights.
        grid.setData(buildGridData(result)).catch((error) => console.error(error));
      }
    }

    const controller = {
      element: bar,

      attachGrid(gridInstance) {
        grid = gridInstance;
      },

      // Rows whose key contains NULL cannot be addressed by an UPDATE.
      rowHasKey(rowIndex) {
        return keyIndexes.every((keyIndex) => {
          const value = result.rows[rowIndex][keyIndex];
          return value !== null && value !== undefined;
        });
      },

      onCellEdited(cell, columnIndex, columnMeta) {
        const rowIndex = cell.getData()._i;
        const parsed = parseInputToScalar(cell.getValue(), columnMeta);
        const original = result.rows[rowIndex][columnIndex];

        const rowChanges = pending.get(rowIndex) || {};
        if (scalarEquals(parsed, original)) {
          delete rowChanges[columnMeta.name];
        } else {
          rowChanges[columnMeta.name] = parsed;
        }
        if (Object.keys(rowChanges).length > 0) {
          pending.set(rowIndex, rowChanges);
        } else {
          pending.delete(rowIndex);
        }

        cell
          .getElement()
          .classList.toggle('dbx-cell-edited', Object.prototype.hasOwnProperty.call(rowChanges, columnMeta.name));

        // Keyword inputs (now()) parse to a different value than what was
        // typed; show the expanded value. The setValue-triggered re-entry
        // parses to itself and stops.
        const expanded = expandNowKeyword(String(cell.getValue() ?? '').trim(), columnMeta);
        if (expanded !== undefined && expanded !== cell.getValue()) {
          cell.setValue(expanded);
          return;
        }

        updateBar();
      },

      buildMenu(cell, columnMeta) {
        const menu = [{ label: 'Copy value', action: (event, menuCell) => copyCellValue(menuCell) }];
        if (columnMeta.nullable) {
          menu.push({
            label: 'Set NULL',
            action: (event, menuCell) => menuCell.setValue(null),
            disabled: cell.getValue() === null || cell.getValue() === undefined,
          });
        }
        return menu;
      },

      submit() {
        const updates = [...pending.entries()].map(([rowIndex, changes]) => ({
          key: {
            kind: editableInfo.keyKind,
            values: Object.fromEntries(
              editableInfo.keyColumns.map((keyName, position) => [
                keyName,
                result.rows[rowIndex][keyIndexes[position]],
              ]),
            ),
          },
          changes,
        }));
        if (updates.length === 0) {
          return;
        }

        submitBtn.disabled = true;
        state.pendingSubmit = controller;
        sendRequest('updateQueryRows', {
          payload: { schema: editableInfo.schema, table: editableInfo.table, updates },
        });
      },

      // Host confirmed the UPDATEs: fold the staged values into the originals.
      commit() {
        for (const [rowIndex, changes] of pending) {
          for (const [columnName, value] of Object.entries(changes)) {
            const columnIndex = result.columns.indexOf(columnName);
            if (columnIndex !== -1) {
              result.rows[rowIndex][columnIndex] = value;
            }
          }
        }
        pending.clear();
        submitBtn.disabled = false;
        resetGridData();
        updateBar();
      },

      // Host rejected the UPDATEs: keep the staged edits for a retry.
      fail() {
        submitBtn.disabled = false;
      },

      revert() {
        pending.clear();
        resetGridData();
        updateBar();
      },
    };

    return controller;
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

  function nullableFormatter(cell) {
    const value = cell.getValue();
    if (value === null || value === undefined) {
      return '<span class="dbx-null">NULL</span>';
    }
    return escapeHtml(String(value));
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
