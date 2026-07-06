# WSL Support Plan

Make OpenVSDB work for sites that live inside WSL: MySQL servers running in a WSL distro and SQLite files on the WSL filesystem. This document is self-contained and intended to be handed off; all file references are current as of 2026-07-02 (commit `f7ac71f`).

## The two scenarios

**Scenario A — Remote-WSL window (primary).** The user opens their site folder via the WSL extension (`\\wsl$` workspace / "WSL: Ubuntu" in the status bar). VS Code runs a server inside the distro; workspace extensions install and execute *inside WSL*. This is the scenario to fully support: the extension host sees Linux paths natively, `localhost:3306` is the WSL MySQL directly, and SQLite files are ordinary local files.

**Scenario B — Local Windows window, site in WSL (secondary).** The user opens VS Code normally on Windows but the database lives in WSL. MySQL is reachable because WSL2 forwards `localhost` ports to Windows. SQLite files are only reachable via `\\wsl$\<distro>\...` UNC paths. Support this with docs and small affordances, not engineering heroics — locking on SQLite files over the 9P/UNC bridge is unreliable by design.

## Current state (verified findings)

1. **`extensionKind` is not declared** in `package.json`. Because the extension has a `main` entry, VS Code defaults it to `workspace`, which is what we want — in a Remote-WSL window it installs and runs inside the distro. We should declare it explicitly so this stays intentional.
2. **`sqlite3@5.1.7` is a native module and the packaged VSIX is single-platform.** `esbuild.js:55` keeps packages external; `.vscodeignore` ships `node_modules/`; the built VSIX contains exactly one binding, `node_modules/sqlite3/build/Release/node_sqlite3.node`, compiled for the packaging machine (currently darwin-arm64). Installed into WSL (linux-x64), that binding fails to load. **This is the ship-blocker.**
3. **The sqlite3 failure is catastrophic, not degraded.** `src/db/sqliteClient.ts:1` does a top-level `import * as sqlite3 from 'sqlite3'`, and `src/db/testConnection.ts` imports it too. With `packages: 'external'`, that becomes a `require('sqlite3')` executed when `dist/extension.js` loads — a missing/wrong binding throws during activation and takes down the whole extension, including MySQL support.
4. **mysql2 is pure JavaScript** — no platform issue. Connections are TCP host/port only (`src/db/mysqlClient.ts:41–65`); no unix-socket or SSH-tunnel support (SSH tunnels are already a "Later" roadmap item; not required for WSL).
5. **File I/O is already remote-safe.** SQL import (`src/webview/explorerPanel.ts:276,286`) and all export destinations (`src/export/exportService.ts:69–212`) use `vscode.window.showOpenDialog/showSaveDialog` + `vscode.workspace.fs`, which resolve on the remote when the extension host is remote. No changes needed.
6. **State is remote-safe.** Connections live in `globalState`, passwords in the Secrets API (`src/state/connectionStore.ts`). Note the consequence: in a Remote-WSL window these stores belong to the *WSL server*, so connections created in a local window don't appear in WSL windows and vice versa. That's standard VS Code behavior — document it, don't fight it.
7. **Webviews are remote-safe.** All three panels use `localResourceRoots` scoped to the extension dir and `asWebviewUri` (`src/webview/utils.ts:15–18`); assets are bundled, nothing loads from the workspace.
8. **Two path-shaped inputs are typed as raw strings** in the add-connection form (`media/main.js`): the SQLite file path (`#sqliteFilePath`, placeholder `/path/to/database.sqlite`) and the MySQL SSL cert paths (read host-side via `fs.readFileSync`, `src/db/mysqlClient.ts:77–85`). Raw `fs` is fine — it runs on whichever host the extension runs on — but typing Linux paths blind is poor UX and the main source of user error in mixed environments.

## Phase 1 — Run-anywhere correctness (small, do first)

### 1.1 Declare `extensionKind`

In `package.json`:

```json
"extensionKind": ["workspace"]
```

Matches what SQLTools/comparable DB extensions do. The extension must run where the database and files are.

### 1.2 Lazy-load sqlite3 and degrade gracefully

Move the `sqlite3` require out of module scope so a missing binding breaks only SQLite features:

- In `src/db/sqliteClient.ts` and `src/db/testConnection.ts`, replace the top-level import with a memoized loader:

```ts
let sqlite3Module: typeof import('sqlite3') | undefined;
function loadSqlite3(): typeof import('sqlite3') {
  if (!sqlite3Module) {
    try {
      sqlite3Module = require('sqlite3');
    } catch (error) {
      throw new Error(
        `SQLite support is unavailable: the native sqlite3 binding failed to load for ${process.platform}-${process.arch}. ` +
        `Install the platform-specific build of OpenVSDB. (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  return sqlite3Module;
}
```

- Keep `import type` for the sqlite3 types (type-only imports are erased by esbuild/tsc, so they don't reintroduce the runtime require).
- Surface the error through the existing connect/test error paths so it appears inline in the modal and as a tree error, not as a dead extension.
- Acceptance: rename `node_sqlite3.node` locally, reload — MySQL connections still work; SQLite connect/test shows the actionable message.

### 1.3 "Browse…" button for the SQLite file path

In the add/edit connection modal (`media/main.js`, `#sqliteFilePath`), add a Browse button that posts a request to `src/webview/explorerPanel.ts`, which runs `vscode.window.showOpenDialog` (filters: `{ 'SQLite database': ['sqlite', 'sqlite3', 'db', 'db3'] }`) and returns `uri.fsPath` to the form. Because the dialog is remote-aware, in a WSL window it browses the WSL filesystem and yields a correct Linux path. Follow the existing request/response protocol used by import/export flows.

Do the same for the three SSL cert path fields (`#mysqlSslCaPath` etc.) — same handler, parameterized by target field. Cheap once the plumbing exists.

### 1.4 Environment hints (polish, optional)

- Host-side, expose `vscode.env.remoteName` (`'wsl'` when remote) to the webview in the state payload.
- In the connection modal, when `remoteName === 'wsl'`: nothing needs to change functionally, but a one-line hint ("Paths and localhost resolve inside WSL") prevents confusion.
- When running locally on Windows (`process.platform === 'win32'`, no remote) and the user types a SQLite path starting with `/` (a Linux path), show an inline warning suggesting either opening the folder in WSL or using the `\\wsl$\<distro>\...` form.

## Phase 2 — Platform-specific packaging (the ship-blocker)

The Marketplace supports platform-specific VSIXs: publish one VSIX per `--target` and each install site (including the WSL server) pulls the right one automatically. sqlite3 5.x uses Node-API prebuilds fetched by `prebuild-install` (a dependency of sqlite3), which accepts `--platform`/`--arch` overrides, so all targets can be cross-packaged from a single Linux runner — no compile toolchain needed. (Node-API also means one binary serves both the Electron extension host and the standalone Node server VS Code uses in WSL — no per-ABI builds.)

### 2.1 CI packaging workflow

Add `.github/workflows/package.yml`, matrix over targets:

| `vsce` target | covers |
|---|---|
| `linux-x64` | **WSL (primary goal)**, most Linux |
| `linux-arm64` | ARM Linux / ARM WSL |
| `win32-x64` | Windows local windows (Scenario B) |
| `darwin-x64`, `darwin-arm64` | current dev platform / macOS users |
| `alpine-x64` *(optional)* | dev containers; add later if wanted |

Per matrix entry:

```bash
npm ci
(cd node_modules/sqlite3 && npx --no-install prebuild-install -r napi --platform $PLATFORM --arch $ARCH --force)  # fetch foreign prebuilt
node -e "require('fs').accessSync('node_modules/sqlite3/build/Release/node_sqlite3.node')"  # fail loudly if fetch silently failed
npx @vscode/vsce package --target $VSCE_TARGET
```

**Status: implemented** in `.github/workflows/package.yml` (matrix over the five targets, cross-fetch + verify + package + upload, publish on `v*` tags when `VSCE_PAT` is set). Notes captured while building it:

- `prebuild-install` drops the binary at `node_modules/sqlite3/build/Release/node_sqlite3.node` (confirmed by a host-target `vsce package`). If cross-fetch ever proves flaky, fall back to a real OS matrix (`ubuntu-latest`, `windows-latest`, `macos-latest`) where `npm ci` natively installs the right binding — slower but boring.
- `package`/`publish` scripts added to `package.json`; `@vscode/vsce` added as a devDependency so packaging is reproducible outside CI.
- `.vscodeignore` trimmed: excludes `node_modules/sqlite3/deps/**`, `src/**`, and everything under `build/` except the one `.node` binding.
- `publisher` changed from the display name `"Craig Jones"` to the ID `"snitzle"` (vsce rejects the former). This must match the publisher registered at the Marketplace.

### 2.2 Smoke test in CI

After packaging `linux-x64`, run a minimal check on an Ubuntu runner: unzip the VSIX, `node -e "const s = require('./extension/node_modules/sqlite3'); new s.Database(':memory:', (e) => process.exit(e ? 1 : 0))"`. This catches a wrong-platform binding before it ships.

### 2.3 (Alternative considered, rejected for now)

Replacing sqlite3 with a WASM driver (sql.js) would eliminate platform builds entirely but loads the whole DB into memory and complicates write-back/transactions — wrong trade-off for a grid editor. `node:sqlite` requires Node ≥ 22.5, above what `engines.vscode ^1.90` guarantees. Revisit if platform packaging becomes a maintenance burden.

## Phase 3 — Scenario B affordances + docs

- **README section "Using OpenVSDB with WSL"**:
  - Recommended: open the site folder in a WSL window (WSL extension); install OpenVSDB "in WSL: <distro>" when prompted; everything (paths, localhost, dialogs) then resolves inside the distro.
  - Local-window alternative: MySQL in WSL2 is reachable at `127.0.0.1:<port>` from Windows (localhost forwarding; note it occasionally breaks after hibernate — `wsl --shutdown` resets it). SQLite files can be opened via `\\wsl$\<distro>\home\...` but WSL's 9P file bridge makes SQLite locking unreliable — recommended only for read-mostly use.
  - Note that connections/passwords are stored per host (local vs each distro) and won't roam between them.
- **Verify UNC handling once on Windows**: sqlite3 accepts `\\wsl$\...` via Node path handling in most cases; confirm and note any caveat in the README rather than adding code.

## Phase 4 — Verification matrix

Manual (F5 dev host + packaged VSIX), in a real WSL2 Ubuntu distro with MySQL and a SQLite file:

| Check | Window | Expected |
|---|---|---|
| Install platform VSIX | WSL window | Installs into WSL, activates, no binding error |
| MySQL connect to `127.0.0.1:3306` (WSL mysqld) | WSL window | Tree loads, grid CRUD, query panel, import/export all work |
| SQLite via Browse… | WSL window | Dialog browses WSL fs; open, edit, export work |
| Export to file | WSL window | Save dialog targets WSL fs; file lands in distro |
| SQL import | WSL window | Reads WSL file; runs |
| Break the binding deliberately | WSL window | MySQL still works; SQLite errors inline with the actionable message |
| MySQL via localhost forwarding | Windows local window | Connects |
| SQLite via `\\wsl$` UNC | Windows local window | Opens read/write on small DB (document caveats) |

Automated: existing `npm test` is platform-neutral; add the Phase 2.2 CI smoke test. Nothing else needs automation for this effort.

## Suggested order & sizing

| Step | Size | Depends on |
|---|---|---|
| 1.1 extensionKind | trivial | — |
| 1.2 lazy sqlite3 | S | — |
| 1.3 Browse buttons | S–M | — |
| 2.1 CI packaging | M | — |
| 2.2 smoke test | S | 2.1 |
| 1.4 env hints | S | 1.3 |
| 3 docs + UNC verify | S | 2.1 (needs a win32 VSIX) |
| 4 verification pass | M | all |

Phases 1 and 2 are independent and can be done in parallel; together they are the definition of "works with WSL."
