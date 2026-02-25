# DB Sidebar Explorer

A free VS Code extension to browse and edit MySQL and SQLite databases from an Activity Bar sidebar webview.

## Features

- Connection tree in sidebar (connections -> schemas -> tables/views)
- Add/edit/remove MySQL and SQLite connections
- Passwords stored with VS Code `SecretStorage`
- Table data grid with pagination, sorting, filtering
- Row actions: insert, duplicate, inline edit with apply/cancel, delete with confirmation
- DDL viewer with copy and open-in-editor
- Read-only fallback if no stable row identifier is available

## Architecture (brief)

- Sidebar Webview (`dbExplorer.sidebar`) is the single UI surface.
- Data flow:
  1. Webview requests tree data.
  2. Extension loads saved connections from `globalState`, resolves passwords from `SecretStorage`, and introspects schemas/tables/views through DB adapters.
  3. On table click, webview requests paged rows with sort/filter options.
  4. Extension builds safe SQL (quoted identifiers + parameterized values), executes, and returns rows + optional row count.
  5. Mutations (insert/update/delete/duplicate) are sent from webview to extension and executed transactionally where possible, then grid refreshes.
- Storage:
  - Non-secret connection metadata is persisted in `globalState` so connections remain available across workspaces.
  - MySQL passwords are stored in `SecretStorage` only.

## Build and run

```bash
npm install
npm run compile
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Notes on SQLite packaging

This extension uses `sqlite3`, which includes native binaries. In CI/release packaging, build for target platforms or ensure prebuilt binaries are available.

## Tests

```bash
npm test
```

Included tests cover SQL identifier quoting, filter SQL generation, and row-identifier strategy selection.
