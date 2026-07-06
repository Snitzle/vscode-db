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

## Later

- WSL support: platform-specific VSIX packaging (sqlite3 native binding), explicit `extensionKind: ["workspace"]`, lazy sqlite3 load, Browse… for path fields — full hand-off plan in `WSL-SUPPORT-PLAN.md`.
- Query panel v2: query history (globalState), export/copy of result grids, autocomplete, EXPLAIN viewer, native `.sql` editor + status-bar connection binding.
- Change values v2: type-aware inline editors (date/boolean/NULL), DML preview before submit, transaction-mode toggle.
- Import v2: CSV/TSV/JSON → table with column-mapping UI and batched transactional inserts.
- Export v2: "Copy as …" cell/row context actions; delimiter/NULL-token/encoding options.
- Inspect: jump-to-page control; image/hex blob viewers.
- Broader parity: PostgreSQL/MariaDB/MSSQL clients, richer schema tree (indexes/FKs/procedures/triggers), FK navigation in the grid, ER diagrams, schema/data compare, environment color-coding, SSH tunnels.

## Verification

- **Unit:** `npm test` (mocha/tsx) — SQL fragments, statement splitting, export extractors, key strategy.
- **Manual:** `npm run dev` browser harness (`dev/explorer.html`, `dev/table.html`, `dev/query.html`) for webview UI; F5 Extension Development Host against a local MySQL + SQLite file for host-side flows (dialogs, QuickPicks, secrets, cleartext auth against an LDAP/PAM server).
