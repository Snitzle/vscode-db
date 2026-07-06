import type * as sqlite3 from 'sqlite3';

/**
 * sqlite3 is a native module: its binding is compiled per platform/arch and only
 * one is shipped in a given (platform-specific) VSIX. If the wrong build lands
 * on a host — most commonly a single-platform VSIX installed into a Linux/WSL
 * remote — `require('sqlite3')` throws. Loading it lazily (rather than at module
 * top level) keeps that failure scoped to SQLite: MySQL and the rest of the
 * extension still activate, and the error surfaces inline when a SQLite
 * connection is actually opened or tested.
 */
let cached: typeof sqlite3 | undefined;

export function loadSqlite3(): typeof sqlite3 {
  if (!cached) {
    try {
      cached = require('sqlite3') as typeof sqlite3;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `SQLite support is unavailable: the native sqlite3 binding failed to load for ` +
          `${process.platform}-${process.arch}. Install the build of OpenVSDB for this platform ` +
          `(the Marketplace serves a platform-specific package per host). (${detail})`,
      );
    }
  }
  return cached;
}
