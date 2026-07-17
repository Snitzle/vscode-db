import { strict as assert } from 'assert';
import { isReadOnlyStatement } from '../src/sql/statements';

describe('isReadOnlyStatement', () => {
  it('accepts plain selects and clauses', () => {
    assert.equal(isReadOnlyStatement('SELECT * FROM users'), true);
    assert.equal(isReadOnlyStatement("select id from users where role = 'Admin' limit 5"), true);
  });

  it('accepts EXPLAIN / SHOW / DESCRIBE', () => {
    assert.equal(isReadOnlyStatement('EXPLAIN select * from users'), true);
    assert.equal(isReadOnlyStatement('SHOW TABLES'), true);
    assert.equal(isReadOnlyStatement('DESCRIBE users'), true);
  });

  it('accepts read-only CTEs', () => {
    assert.equal(isReadOnlyStatement('WITH top AS (SELECT * FROM users) SELECT * FROM top'), true);
  });

  it('rejects data-modifying statements', () => {
    assert.equal(isReadOnlyStatement('UPDATE users SET role = 1'), false);
    assert.equal(isReadOnlyStatement('DELETE FROM users'), false);
    assert.equal(isReadOnlyStatement('INSERT INTO users VALUES (1)'), false);
    assert.equal(isReadOnlyStatement('DROP TABLE users'), false);
    assert.equal(isReadOnlyStatement('CREATE TABLE t (id int)'), false);
  });

  it('rejects PRAGMA (it can write)', () => {
    assert.equal(isReadOnlyStatement('PRAGMA journal_mode = WAL'), false);
    assert.equal(isReadOnlyStatement('PRAGMA table_info(users)'), false);
  });

  it('rejects CTEs that smuggle DML', () => {
    assert.equal(isReadOnlyStatement('WITH t AS (SELECT 1) UPDATE users SET a = 1'), false);
    assert.equal(isReadOnlyStatement('WITH t AS (SELECT 1) INSERT INTO log SELECT * FROM t'), false);
    assert.equal(isReadOnlyStatement('WITH t AS (SELECT 1) DELETE FROM users'), false);
  });

  it('rejects SELECT INTO OUTFILE/DUMPFILE', () => {
    assert.equal(isReadOnlyStatement("SELECT * FROM users INTO OUTFILE '/tmp/x.csv'"), false);
    assert.equal(isReadOnlyStatement("SELECT * FROM users INTO DUMPFILE '/tmp/x'"), false);
  });

  it('rejects multi-statement scripts', () => {
    assert.equal(isReadOnlyStatement('SELECT 1; DROP TABLE users'), false);
  });
});
