import { strict as assert } from 'assert';
import { chooseWritableKey } from '../src/db/keyStrategy';

describe('writable key strategy', () => {
  it('prefers primary keys', () => {
    const key = chooseWritableKey({
      primaryKeyColumns: ['id'],
      uniqueIndexCandidates: [
        {
          columns: ['email'],
          nullable: false,
        },
      ],
      allowRowId: true,
    });

    assert.equal(key.kind, 'primary');
    assert.deepEqual(key.columns, ['id']);
  });

  it('falls back to non-null unique index', () => {
    const key = chooseWritableKey({
      primaryKeyColumns: [],
      uniqueIndexCandidates: [
        {
          columns: ['email'],
          nullable: false,
        },
      ],
      allowRowId: false,
    });

    assert.equal(key.kind, 'unique');
    assert.deepEqual(key.columns, ['email']);
  });

  it('falls back to rowid when allowed', () => {
    const key = chooseWritableKey({
      primaryKeyColumns: [],
      uniqueIndexCandidates: [],
      allowRowId: true,
    });

    assert.equal(key.kind, 'rowid');
  });

  it('returns none when no safe key exists', () => {
    const key = chooseWritableKey({
      primaryKeyColumns: [],
      uniqueIndexCandidates: [
        {
          columns: ['optional_unique'],
          nullable: true,
        },
      ],
      allowRowId: false,
    });

    assert.equal(key.kind, 'none');
    assert.match(key.reason ?? '', /No primary key/);
  });
});
