# OpenVSDB Roadmap

## Context

The maintainer migrated from IntelliJ/DataGrip and most misses its database integration. OpenVSDB is a MySQL + SQLite browser/editor: a sidebar webview explorer, Tabulator-based table grids in editor tabs, inline CRUD with transactions, multi-filter querying, and multi-format export. Daily workflows it serves: **inspect, change values, run queries, import, export**.

## Architecture snapshot

- **Explorer** — sidebar `WebviewViewProvider` (`dbExplorer.home`), persists tree state via webview `setState`; per-connection actions in a kebab menu.
- **Table grid** — `TablePanelManager` + `media/tablePanel.js` (Tabulator, VS Code-themed via `media/tabulator-vscode.css`); rebuildless data refreshes (`replaceData`), multi-filter chips ANDed with a raw WHERE.
- **Clients** — `DatabaseClient` interface over `mysqlClient` / `sqliteClient`; `executeRaw()` runs multi-statement scripts and is the foundation for query panel, SQL import, and dumps.
- **Export** — `src/export/extractors.ts` (CSV/TSV/JSON/SQL/Markdown, unit-tested) + `exportService.ts` QuickPick flows; whole-DB SQL dump.
- **Webview assets** — esbuild-bundled (`dist/*`); browser harness under `dev/` (`npm run dev`) speaks the real protocol with fixtures.

## Shipped

- **2026-06-23 — Stage 0 foundation:** esbuild pipeline, Tabulator grid, native theming, `executeRaw()` on both clients.
- **2026-07-01 — Inspect + density pass:** compact toolbar, value viewer, aggregate strip, find-in-page, multi-column sort, raw WHERE, filter-by-cell.
- **2026-07-02 — Sidebar + filters + export:** explorer moved into the sidebar with persistent tree state; `filters[]` ANDed with raw WHERE + chip UI; export (selection/page/table → CSV, TSV, JSON, SQL INSERTs, Markdown → file/clipboard) and whole-database SQL dump; grid readability fixes (scoped form CSS, translucent selection, flex height, layout-preserving refreshes, paging/find fixes).
- **2026-07-02 — Rename + sidebar declutter:** OpenVSDB naming; title-bar Add/Refresh only; per-connection kebab (Export / Edit / Remove) that behaves at sidebar widths.

## Now (planned 2026-07-02, all shipped 2026-07-02)

- [x] **CSV export** — shipped as part of the export flow (Export button → scope → CSV → file/clipboard).
- [x] **Connection modal polish** — vertical rhythm between form sections (flex/gap stacks instead of unspaced blocks), tidier SSL details section.
- [x] **Test connection button** — in the add/edit modal; tests the *current form values* host-side (MySQL: real connect + `SELECT VERSION()`; SQLite: read-only open). Editing with a blank password reuses the stored secret. Result shown inline in the modal.
- [x] **Clear-text authentication** — "Allow cleartext authentication" checkbox on MySQL connections (the `mysql_clear_password` plugin, required by LDAP/PAM-backed servers; DataGrip parity). Persisted on the connection meta, wired into the mysql2 pool and the tester.
- [x] **SQL import** — kebab action per connection: pick a `.sql` file, confirm with a statement count (host-side modal), run through `executeRaw`, report statements/affected rows, refresh the tree and open grids.
- [x] **Query panel** — kebab action "New query" opens an editor-tab webview bound to the connection: SQL textarea, Run (⌘/Ctrl+Enter; runs the selection when one exists), per-statement results — Tabulator grid for row sets, affected-rows/insert-id summary for DML — with execution times and inline errors. DML runs refresh that connection's open table grids.
- [x] **Export abstraction (2026-07-02)** — export decomposed into source × format × destination (`src/export/tableSource.ts` streams table datasets lazily; the format registry carries `container`/`supportsClipboard` flags). The matrix: **table** (selection / page / entire-table-with-filters — the scope pick shows the active filters/sort), **database** (SQL dump into one `.sql`, or CSV as a folder with one file per table, views included as data), and **query result** (per-result Export button; CSV/TSV/JSON/Markdown/SQL INSERTs with a prompted table name; duplicate columns suffixed for JSON). Table SQL exports now include the CREATE statement.

## Shipped 2026-07-16 — sidebar UX + grid editing pass

- **Lazy connect** — the sidebar no longer connects to every DB on load; per-connection plug/reload button, `disconnected` tree state, connect errors shown on the card; saving a connection still connects immediately.
- **Connection folders (collections)** — foldable, drag-and-droppable groups (`dbExplorer.folders` + `folderId` per connection); host-side create/rename/remove dialogs; drops move between folders/top level atomically (`applyMove`, unit-tested).
- **Per-connection table search** — search icon per card filters just that connection, combinable with the global filter; focus survives re-renders.
- **Grid polish** — vertically centered rows, centered selection checkboxes (incl. frozen-cell override), right-click **Set NULL**, `now()` keyword expands to the column-appropriate current date/time (shared `media/valueParsing.js`).
- **Editable query results** — single-table SELECTs detected host-side (`src/sql/selectSource.ts`, unit-tested) become editable grids with pending edits + Submit via keyed UPDATEs; joins/unions/DISTINCT/subqueries stay read-only by design.

## Shipped 2026-07-16 — TablePro-parity pass

- **Settings Sync** — connections + folders roam via `setKeysForSync`; secrets stay local.
- **Query history** — capped, deduped log (`dbExplorer.queryHistory`, unit-tested) recorded on every run (panels + .sql documents); History button opens a full-text QuickPick that inserts into the editor; `OpenVSDB: Clear Query History` command.
- **Grid undo/redo** — ⌘/Ctrl+Z / ⇧⌘Z over staged cell edits in the table grid (before Submit); now()-expansions undo as one step.
- **SSH tunnels** — `ssh2` local port-forward per MySQL connection (password / key / agent auth, secrets in SecretStorage), wired into client manager + test connection; SSH section in the connection modal.
- **Native .sql editor binding** — status-bar picker + CodeLens bind a real `.sql` document to a connection; Run (editor title ▶, lens, or command) executes the selection/script into a reusable results-only panel beside the editor. Multi-cursor/vim/Copilot come free.
- **Environments** — `local`/`staging`/`prod` per connection: colored card edge + badge in the sidebar, top strip + badge on table/query panels, and PRODUCTION-labelled confirmations for deletes, imports, and row updates against prod.
- **Language-model tools** — `#dbSchemas`, `#dbTable`, `#dbQuery` (`contributes.languageModelTools` + `vscode.lm.registerTool`): chat agents can list schemas, describe tables, and run a single read-only statement (guarded by `isReadOnlyStatement`, unit-tested; 100-row cap; user confirmation on query runs). **Explain** button in the query panel wraps the script in `EXPLAIN` / `EXPLAIN QUERY PLAN`.
- **Deep links** — `vscode://<ext-id>/open?connection=…[&schema=…&table=…&type=view]` opens a grid or query console.

## Shipped 2026-07-17 — node:sqlite migration

- **Dropped the `sqlite3` native addon** for the Node built-in `node:sqlite` (`DatabaseSync`): one universal VSIX for every OS/architecture — no platform-specific packaging matrix, no install-time binary downloads, ~5 MB lighter. Spike-verified inside VS Code 1.129's own Electron runtime (Node 24.18); `engines.vscode` raised to `^1.102.0` (first releases with Node ≥ 22.13 in the extension host).
- Behaviour preserved: async `DatabaseClient` contract, missing-file open errors (an `existsSync` guard — `DatabaseSync` would otherwise create the file), locked-DB retries (`errcode 5` added to `isLockedSqliteError`), boolean/undefined parameter coercion, BLOBs as hex (`Uint8Array` handling in `toScalar`), read-only test-connection opens.
- **Real integration tests**: with no native addon, `test/sqliteClient.test.ts` runs the actual client against a temp database under mocha (schema listing, keys/autoincrement, paging + filters + counts, CRUD through row keys, raw scripts, view read-onlyness, DDL, BLOB rendering). The suite also passes when run under VS Code's Electron binary (`ELECTRON_RUN_AS_NODE=1`).

## Later

- Query panel v2: autocomplete, EXPLAIN visualizer, result-grid copy actions.
- Change values v2: type-aware inline editors (date/boolean pickers), DML preview before submit, transaction-mode toggle.
- Import v2: CSV/TSV/JSON → table with column-mapping UI and batched transactional inserts.
- Export v2: "Copy as …" cell/row context actions; delimiter/NULL-token/encoding options.
- Inspect: jump-to-page control; image/hex blob viewers.
- Broader parity: PostgreSQL/MariaDB/MSSQL clients, richer schema tree (indexes/FKs/procedures/triggers), FK navigation in the grid, ER diagrams, schema/data compare.

## Verification

- **Unit:** `npm test` (mocha/tsx) — SQL fragments, statement splitting, export extractors, key strategy.
- **Manual:** `npm run dev` browser harness (`dev/explorer.html`, `dev/table.html`, `dev/query.html`) for webview UI; F5 Extension Development Host against a local MySQL + SQLite file for host-side flows (dialogs, QuickPicks, secrets, cleartext auth against an LDAP/PAM server).
