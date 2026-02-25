import { strict as assert } from 'assert';
import { buildOrderByClause, buildWhereClause } from '../src/sql/queryFragments';

describe('query fragments', () => {
  it('builds where clause for contains operator', () => {
    const result = buildWhereClause(
      'mysql',
      {
        column: 'name',
        operator: 'contains',
        value: 'ali',
      },
      new Set(['name']),
    );

    assert.equal(result.sql, 'WHERE `name` LIKE ?');
    assert.deepEqual(result.params, ['%ali%']);
  });

  it('builds where clause for null checks', () => {
    const result = buildWhereClause(
      'sqlite',
      {
        column: 'deleted_at',
        operator: 'isNull',
      },
      new Set(['deleted_at']),
    );

    assert.equal(result.sql, 'WHERE "deleted_at" IS NULL');
    assert.deepEqual(result.params, []);
  });

  it('builds order by clause', () => {
    const result = buildOrderByClause(
      'sqlite',
      {
        column: 'created_at',
        direction: 'desc',
      },
      new Set(['created_at']),
    );

    assert.equal(result, 'ORDER BY "created_at" DESC');
  });

  it('rejects unknown columns', () => {
    assert.throws(() => {
      buildWhereClause(
        'mysql',
        {
          column: 'unsafe',
          operator: 'eq',
          value: 'x',
        },
        new Set(['safe']),
      );
    });
  });
});
