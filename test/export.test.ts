import { strict as assert } from 'assert';
import { ExportTableData, renderExport, sqlInsertStatements, sqlLiteral } from '../src/export/extractors';

const data: ExportTableData = {
  schema: 'main',
  table: 'users',
  columns: ['id', 'name', 'notes', 'score'],
  rows: [
    [1, 'Ada Lovelace', 'said "hi", twice', 9.5],
    [2, "O'Brien", null, null],
  ],
};

describe('export extractors', () => {
  it('renders CSV with quoting for delimiters and quotes', () => {
    const csv = renderExport('csv', data, 'sqlite');
    const lines = csv.split('\n');

    assert.equal(lines[0], 'id,name,notes,score');
    assert.equal(lines[1], '1,Ada Lovelace,"said ""hi"", twice",9.5');
    assert.equal(lines[2], "2,O'Brien,,");
  });

  it('renders TSV, only quoting values that need it', () => {
    const tsv = renderExport('tsv', data, 'sqlite');
    const lines = tsv.split('\n');

    assert.equal(lines[0], 'id\tname\tnotes\tscore');
    // Commas are plain in TSV; embedded quotes still force quoting.
    assert.equal(lines[1], '1\tAda Lovelace\t"said ""hi"", twice"\t9.5');
    assert.equal(lines[2], "2\tO'Brien\t\t");
  });

  it('renders JSON with nulls preserved', () => {
    const parsed = JSON.parse(renderExport('json', data, 'sqlite'));

    assert.equal(parsed.length, 2);
    assert.deepEqual(parsed[1], { id: 2, name: "O'Brien", notes: null, score: null });
  });

  it('renders SQL INSERT statements with escaped literals', () => {
    const statements = sqlInsertStatements(data, 'sqlite');

    assert.equal(statements.length, 2);
    assert.equal(
      statements[0],
      'INSERT INTO "main"."users" ("id", "name", "notes", "score") VALUES (1, \'Ada Lovelace\', \'said "hi", twice\', 9.5);',
    );
    assert.equal(
      statements[1],
      'INSERT INTO "main"."users" ("id", "name", "notes", "score") VALUES (2, \'O\'\'Brien\', NULL, NULL);',
    );
  });

  it('escapes backslashes for MySQL literals only', () => {
    assert.equal(sqlLiteral('a\\b', 'mysql'), "'a\\\\b'");
    assert.equal(sqlLiteral('a\\b', 'sqlite'), "'a\\b'");
    assert.equal(sqlLiteral(true, 'mysql'), '1');
    assert.equal(sqlLiteral(null, 'mysql'), 'NULL');
  });

  it('renders a Markdown table with escaped pipes', () => {
    const md = renderExport(
      'markdown',
      { ...data, rows: [[1, 'a|b', 'line1\nline2', null]] },
      'sqlite',
    );
    const lines = md.split('\n');

    assert.equal(lines[0], '| id | name | notes | score |');
    assert.equal(lines[1], '| --- | --- | --- | --- |');
    assert.equal(lines[2], '| 1 | a\\|b | line1 line2 |  |');
  });
});
