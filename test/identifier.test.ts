import { strict as assert } from 'assert';
import { quoteIdentifier, quoteQualifiedIdentifier } from '../src/sql/identifier';

describe('identifier quoting', () => {
  it('quotes mysql identifiers with backticks', () => {
    assert.equal(quoteIdentifier('mysql', 'users'), '`users`');
    assert.equal(quoteIdentifier('mysql', 'we`ird'), '`we``ird`');
  });

  it('quotes sqlite identifiers with double quotes', () => {
    assert.equal(quoteIdentifier('sqlite', 'users'), '"users"');
    assert.equal(quoteIdentifier('sqlite', 'a"b'), '"a""b"');
  });

  it('quotes qualified identifiers', () => {
    assert.equal(quoteQualifiedIdentifier('mysql', 'app', 'users'), '`app`.`users`');
    assert.equal(quoteQualifiedIdentifier('sqlite', 'main', 'users'), '"main"."users"');
  });
});
