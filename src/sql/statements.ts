/**
 * Split a SQL script into individual statements on top-level semicolons,
 * ignoring semicolons that appear inside string literals, quoted identifiers,
 * and line/block comments. Trailing empty statements are dropped.
 *
 * This is intentionally dialect-light: it is good enough to let a SQL console
 * run a multi-statement script against engines (like SQLite) whose drivers
 * execute one statement per call. It is not a full SQL parser.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';

  let inSingle = false; // '...'
  let inDouble = false; // "..."
  let inBacktick = false; // `...`
  let inLineComment = false; // -- ...
  let inBlockComment = false; // /* ... */

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') {
        inLineComment = false;
      }
      continue;
    }

    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (inSingle) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"') {
        if (next === '"') {
          current += next;
          i += 1;
        } else {
          inDouble = false;
        }
      }
      continue;
    }

    if (inBacktick) {
      current += ch;
      if (ch === '`') {
        inBacktick = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }

    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }

    if (ch === '`') {
      inBacktick = true;
      current += ch;
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Heuristic: does a single statement produce a result set (rows) rather than
 * just an affected-row count? Used by drivers that need to pick between a
 * "query rows" call and a "run statement" call.
 */
export function statementReturnsRows(statement: string): boolean {
  const head = statement.replace(/^[\s(]+/, '').toUpperCase();
  return /^(SELECT|PRAGMA|WITH|EXPLAIN|VALUES|SHOW|DESCRIBE|DESC)\b/.test(head);
}

/**
 * Conservative read-only check for a single statement, used to gate what the
 * language-model tools may execute. False negatives are fine (the model just
 * can't run that query); false positives are not, so anything ambiguous is
 * rejected:
 * - only SELECT / WITH…SELECT / EXPLAIN / SHOW / DESCRIBE heads are allowed
 *   (PRAGMA is rejected outright — `PRAGMA x = y` writes);
 * - WITH bodies must not smuggle data-modifying keywords (MySQL and SQLite
 *   both allow `WITH … UPDATE/INSERT/DELETE`);
 * - `SELECT … INTO OUTFILE/DUMPFILE` (writes server-side files) is rejected.
 */
export function isReadOnlyStatement(statement: string): boolean {
  if (splitSqlStatements(statement).length !== 1) {
    return false;
  }

  const head = statement.replace(/^[\s(]+/, '').toUpperCase();
  if (!/^(SELECT|WITH|EXPLAIN|SHOW|DESCRIBE|DESC)\b/.test(head)) {
    return false;
  }

  if (/\b(INSERT|UPDATE|DELETE|REPLACE|MERGE)\b/i.test(statement) && /^WITH\b/.test(head)) {
    return false;
  }

  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(statement)) {
    return false;
  }

  return true;
}
