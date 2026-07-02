import { strict as assert } from 'assert';
import { buildFilterClause, buildOrderByClause, buildWhereClause } from '../src/sql/queryFragments';

describe('query fragments', () => {
  it('builds where clause for contains operator', () => {
    const result = buildWhereClause(
      'mysql',
      [
        {
          column: 'name',
          operator: 'contains',
          value: 'ali',
        },
      ],
      new Set(['name']),
    );

    assert.equal(result.sql, 'WHERE `name` LIKE ?');
    assert.deepEqual(result.params, ['%ali%']);
  });

  it('builds where clause for null checks', () => {
    const result = buildWhereClause(
      'sqlite',
      [
        {
          column: 'deleted_at',
          operator: 'isNull',
        },
      ],
      new Set(['deleted_at']),
    );

    assert.equal(result.sql, 'WHERE "deleted_at" IS NULL');
    assert.deepEqual(result.params, []);
  });

  it('joins multiple filters with AND, keeping parameter order', () => {
    const result = buildWhereClause(
      'mysql',
      [
        { column: 'role', operator: 'eq', value: 'Owner' },
        { column: 'score', operator: 'gte', value: 10 },
        { column: 'email', operator: 'isNotNull' },
      ],
      new Set(['role', 'score', 'email']),
    );

    assert.equal(result.sql, 'WHERE `role` = ? AND `score` >= ? AND `email` IS NOT NULL');
    assert.deepEqual(result.params, ['Owner', 10]);
  });

  it('builds order by clause', () => {
    const result = buildOrderByClause(
      'sqlite',
      [{ column: 'created_at', direction: 'desc' }],
      new Set(['created_at']),
    );

    assert.equal(result, 'ORDER BY "created_at" DESC');
  });

  it('builds a multi-column order by clause', () => {
    const result = buildOrderByClause(
      'mysql',
      [
        { column: 'name', direction: 'asc' },
        { column: 'created_at', direction: 'desc' },
      ],
      new Set(['name', 'created_at']),
    );

    assert.equal(result, 'ORDER BY `name` ASC, `created_at` DESC');
  });

  it('uses a raw where clause verbatim', () => {
    const result = buildFilterClause('mysql', { where: "status = 'active'" }, new Set(['status']));

    assert.equal(result.sql, "WHERE (status = 'active')");
    assert.deepEqual(result.params, []);
  });

  it('uses the structured filters when no raw where is given', () => {
    const result = buildFilterClause(
      'sqlite',
      { filters: [{ column: 'name', operator: 'eq', value: 'x' }] },
      new Set(['name']),
    );

    assert.equal(result.sql, 'WHERE "name" = ?');
    assert.deepEqual(result.params, ['x']);
  });

  it('combines structured filters with a raw where clause', () => {
    const result = buildFilterClause(
      'sqlite',
      {
        filters: [
          { column: 'role', operator: 'eq', value: 'Owner' },
          { column: 'name', operator: 'contains', value: 'ada' },
        ],
        where: 'events_count = 1',
      },
      new Set(['role', 'name']),
    );

    assert.equal(result.sql, 'WHERE "role" = ? AND "name" LIKE ? AND (events_count = 1)');
    assert.deepEqual(result.params, ['Owner', '%ada%']);
  });

  it('returns an empty clause when nothing filters', () => {
    const result = buildFilterClause('mysql', {}, new Set(['name']));

    assert.equal(result.sql, '');
    assert.deepEqual(result.params, []);
  });

  it('rejects unknown columns', () => {
    assert.throws(() => {
      buildWhereClause(
        'mysql',
        [
          {
            column: 'unsafe',
            operator: 'eq',
            value: 'x',
          },
        ],
        new Set(['safe']),
      );
    });
  });
});
