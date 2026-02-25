export type SqlDialect = 'mysql' | 'sqlite';

export function quoteIdentifier(dialect: SqlDialect, identifier: string): string {
  if (!identifier || identifier.trim().length === 0) {
    throw new Error('Identifier cannot be empty.');
  }

  if (dialect === 'mysql') {
    return `\`${identifier.replace(/`/g, '``')}\``;
  }

  return `"${identifier.replace(/"/g, '""')}"`;
}

export function quoteQualifiedIdentifier(dialect: SqlDialect, ...parts: string[]): string {
  return parts.map((part) => quoteIdentifier(dialect, part)).join('.');
}
