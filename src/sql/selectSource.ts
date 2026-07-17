/**
 * Detects whether a statement is a simple single-table SELECT — the shape whose
 * result set can be edited in place and written back with UPDATEs, DataGrip
 * style. Deliberately conservative: joins, unions, grouping, DISTINCT, and
 * subqueries all disqualify a statement (a false negative just means the grid
 * stays read-only, while a false positive would write updates to the wrong
 * rows).
 */

export interface SelectSource {
  schema?: string;
  table: string;
}

const DISQUALIFIERS = /\b(join|union|group\s+by|having|distinct)\b/i;

// One identifier: `quoted`, "quoted", [quoted], or a bare word.
const IDENTIFIER = String.raw`(?:\`[^\`]+\`|"[^"]+"|\[[^\]]+\]|[\w$]+)`;
const FROM_TARGET = new RegExp(String.raw`\bfrom\s+(${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})?)`, 'i');

export function parseSingleTableSelect(sql: string): SelectSource | undefined {
  const stripped = stripComments(sql).trim();

  if (!/^select\b/i.test(stripped)) {
    return undefined;
  }
  if (DISQUALIFIERS.test(stripped) || /\(\s*select\b/i.test(stripped)) {
    return undefined;
  }

  const match = FROM_TARGET.exec(stripped);
  if (!match) {
    return undefined;
  }

  // Multiple FROM targets ("FROM a, b") make it a join in disguise. A comma in
  // the rest of the FROM clause (before WHERE/ORDER/LIMIT or the end) rejects.
  const afterTarget = stripped.slice(match.index + match[0].length);
  const clauseStart = afterTarget.search(/\b(where|order\s+by|limit|offset)\b/i);
  const fromTail = clauseStart === -1 ? afterTarget : afterTarget.slice(0, clauseStart);
  if (fromTail.includes(',')) {
    return undefined;
  }

  const parts = match[1].split(/\s*\.\s*/).map(unquoteIdentifier);
  if (parts.length === 2) {
    return { schema: parts[0], table: parts[1] };
  }
  return { table: parts[0] };
}

function unquoteIdentifier(raw: string): string {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === '`' && last === '`') || (first === '"' && last === '"') || (first === '[' && last === ']')) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * Remove -- line comments and slash-star block comments so keywords hidden in
 * comments don't disqualify a statement (and commented-out FROMs don't match).
 * String literals are respected so a quoted "--" survives.
 */
function stripComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inSingle || inDouble || inBacktick) {
      out += ch;
      if (inSingle && ch === "'") {
        if (next === "'") {
          out += next;
          i += 1;
        } else {
          inSingle = false;
        }
      } else if (inDouble && ch === '"') {
        if (next === '"') {
          out += next;
          i += 1;
        } else {
          inDouble = false;
        }
      } else if (inBacktick && ch === '`') {
        inBacktick = false;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      out += ' ';
      continue;
    }

    if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === '`') {
      inBacktick = true;
    }
    out += ch;
  }

  return out;
}
