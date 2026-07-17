import { strict as assert } from 'assert';
import { parseSingleTableSelect } from '../src/sql/selectSource';

describe('parseSingleTableSelect', () => {
  it('parses a bare select', () => {
    assert.deepEqual(parseSingleTableSelect('SELECT * FROM users'), { table: 'users' });
  });

  it('parses a schema-qualified table', () => {
    assert.deepEqual(parseSingleTableSelect('select id, name from api.users where id > 3'), {
      schema: 'api',
      table: 'users',
    });
  });

  it('unquotes backtick, double-quote, and bracket identifiers', () => {
    assert.deepEqual(parseSingleTableSelect('select * from `my db`.`user table`'), {
      schema: 'my db',
      table: 'user table',
    });
    assert.deepEqual(parseSingleTableSelect('select * from "users"'), { table: 'users' });
    assert.deepEqual(parseSingleTableSelect('select * from [users]'), { table: 'users' });
  });

  it('allows WHERE / ORDER BY / LIMIT clauses', () => {
    assert.deepEqual(
      parseSingleTableSelect("select * from users where role = 'Admin' order by id desc limit 10"),
      { table: 'users' },
    );
  });

  it('rejects non-select statements', () => {
    assert.equal(parseSingleTableSelect('UPDATE users SET a = 1'), undefined);
    assert.equal(parseSingleTableSelect('delete from users'), undefined);
    assert.equal(parseSingleTableSelect('pragma table_info(users)'), undefined);
  });

  it('rejects joins, unions, grouping, and distinct', () => {
    assert.equal(parseSingleTableSelect('select * from a join b on a.id = b.id'), undefined);
    assert.equal(parseSingleTableSelect('select * from a union select * from b'), undefined);
    assert.equal(parseSingleTableSelect('select role, count(*) from users group by role'), undefined);
    assert.equal(parseSingleTableSelect('select distinct role from users'), undefined);
  });

  it('rejects multi-table FROM clauses', () => {
    assert.equal(parseSingleTableSelect('select * from a, b'), undefined);
    assert.equal(parseSingleTableSelect('select * from a, b where a.id = b.id'), undefined);
  });

  it('accepts a comma after the FROM clause ends', () => {
    assert.deepEqual(parseSingleTableSelect("select * from a where x in ('p', 'q')"), { table: 'a' });
  });

  it('rejects subqueries', () => {
    assert.equal(parseSingleTableSelect('select * from (select * from users)'), undefined);
    assert.equal(parseSingleTableSelect('select (select max(id) from b) from a'), undefined);
  });

  it('ignores keywords inside comments', () => {
    assert.deepEqual(parseSingleTableSelect('select * -- join later\nfrom users'), { table: 'users' });
    assert.deepEqual(parseSingleTableSelect('select * /* union */ from users'), { table: 'users' });
  });

  it('does not let a commented-out FROM win', () => {
    assert.deepEqual(parseSingleTableSelect('select * -- from ghosts\nfrom users'), { table: 'users' });
  });
});
