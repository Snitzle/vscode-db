# DB Sidebar Explorer

A free VS Code extension to browse and edit MySQL and SQLite databases from an Activity Bar sidebar tree and editor tabs.

## Features

- Connection tree in sidebar (connections -> schemas -> tables/views)
- Add/edit/remove MySQL and SQLite connections
- Passwords stored with VS Code `SecretStorage`
- Table/view tabs open in the main editor area when clicked from the sidebar
- Table data grid with pagination, sorting, filtering
- Row actions: insert, duplicate, inline edit with apply/cancel, delete with confirmation
- DDL viewer with copy and open-in-editor
- Read-only fallback if no stable row identifier is available

## Architecture (brief)

- Sidebar Webview (`dbExplorer.sidebar`) handles connection management and navigation.
- Table/view content opens in dedicated webview editor tabs in the main workbench area.
- Data flow:
  1. Webview requests tree data.
  2. Extension loads saved connections from `globalState`, resolves passwords from `SecretStorage`, and introspects schemas/tables/views through DB adapters.
  3. On table click, the extension opens or reveals a dedicated editor tab for that object.
  4. The table tab requests paged rows with sort/filter options.
  5. Extension builds safe SQL (quoted identifiers + parameterized values), executes, and returns rows + optional row count.
  6. Mutations (insert/update/delete/duplicate) are sent from the tab webview to the extension and executed transactionally where possible, then the grid refreshes.
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
