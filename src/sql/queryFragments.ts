import { FilterSpec, Scalar, SortSpec } from '../types';
import { SqlDialect, quoteIdentifier } from './identifier';

export interface ClauseBuildResult {
  sql: string;
  params: Scalar[];
}

function ensureAllowedColumn(column: string, allowedColumns: Set<string>): void {
  if (!allowedColumns.has(column)) {
    throw new Error(`Unknown column in filter/sort: ${column}`);
  }
}

/** One filter as a bare SQL condition (no WHERE keyword). */
function buildCondition(
  dialect: SqlDialect,
  filter: FilterSpec,
  allowedColumns: Set<string>,
): ClauseBuildResult {
  ensureAllowedColumn(filter.column, allowedColumns);
  const columnSql = quoteIdentifier(dialect, filter.column);

  switch (filter.operator) {
    case 'eq':
      return { sql: `${columnSql} = ?`, params: [filter.value ?? null] };
    case 'neq':
      return { sql: `${columnSql} <> ?`, params: [filter.value ?? null] };
    case 'gt':
      return { sql: `${columnSql} > ?`, params: [filter.value ?? null] };
    case 'gte':
      return { sql: `${columnSql} >= ?`, params: [filter.value ?? null] };
    case 'lt':
      return { sql: `${columnSql} < ?`, params: [filter.value ?? null] };
    case 'lte':
      return { sql: `${columnSql} <= ?`, params: [filter.value ?? null] };
    case 'contains':
      return { sql: `${columnSql} LIKE ?`, params: [`%${String(filter.value ?? '')}%`] };
    case 'startsWith':
      return { sql: `${columnSql} LIKE ?`, params: [`${String(filter.value ?? '')}%`] };
    case 'endsWith':
      return { sql: `${columnSql} LIKE ?`, params: [`%${String(filter.value ?? '')}`] };
    case 'isNull':
      return { sql: `${columnSql} IS NULL`, params: [] };
    case 'isNotNull':
      return { sql: `${columnSql} IS NOT NULL`, params: [] };
    default:
      throw new Error(`Unsupported filter operator: ${(filter as FilterSpec).operator}`);
  }
}

export function buildWhereClause(
  dialect: SqlDialect,
  filters: FilterSpec[] | undefined,
  allowedColumns: Set<string>,
): ClauseBuildResult {
  if (!filters || filters.length === 0) {
    return { sql: '', params: [] };
  }

  const conditions = filters.map((filter) => buildCondition(dialect, filter, allowedColumns));
  return {
    sql: `WHERE ${conditions.map((condition) => condition.sql).join(' AND ')}`,
    params: conditions.flatMap((condition) => condition.params),
  };
}

export function buildOrderByClause(
  dialect: SqlDialect,
  sort: SortSpec[] | undefined,
  allowedColumns: Set<string>,
): string {
  if (!sort || sort.length === 0) {
    return '';
  }

  const terms = sort.map((spec) => {
    ensureAllowedColumn(spec.column, allowedColumns);
    const direction = spec.direction === 'desc' ? 'DESC' : 'ASC';
    return `${quoteIdentifier(dialect, spec.column)} ${direction}`;
  });

  return `ORDER BY ${terms.join(', ')}`;
}

/**
 * Combine the structured filters with a raw user-supplied WHERE clause (SQL
 * without the WHERE keyword). All conditions are ANDed together; the raw
 * clause is parenthesized and passed through verbatim.
 */
export function buildFilterClause(
  dialect: SqlDialect,
  options: { where?: string; filters?: FilterSpec[] },
  allowedColumns: Set<string>,
): ClauseBuildResult {
  const conditions = (options.filters ?? []).map((filter) =>
    buildCondition(dialect, filter, allowedColumns),
  );

  const parts = conditions.map((condition) => condition.sql);
  const raw = typeof options.where === 'string' ? options.where.trim() : '';
  if (raw) {
    parts.push(`(${raw})`);
  }

  if (parts.length === 0) {
    return { sql: '', params: [] };
  }

  return {
    sql: `WHERE ${parts.join(' AND ')}`,
    params: conditions.flatMap((condition) => condition.params),
  };
}
