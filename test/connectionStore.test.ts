import { strict as assert } from 'assert';
import { applyMove, applyOrder } from '../src/state/connectionStore';

interface Item {
  id: string;
  folderId?: string;
}

function items(...ids: string[]): Item[] {
  return ids.map((id) => ({ id }));
}

function ids(list: Item[]): string[] {
  return list.map((item) => item.id);
}

describe('applyOrder', () => {
  it('reorders items to match the requested id order', () => {
    const result = applyOrder(items('a', 'b', 'c'), ['c', 'a', 'b']);
    assert.deepEqual(ids(result), ['c', 'a', 'b']);
  });

  it('is a no-op when the order already matches', () => {
    const result = applyOrder(items('a', 'b', 'c'), ['a', 'b', 'c']);
    assert.deepEqual(ids(result), ['a', 'b', 'c']);
  });

  it('preserves the original object references', () => {
    const source = items('a', 'b');
    const result = applyOrder(source, ['b', 'a']);
    assert.equal(result[0], source[1]);
    assert.equal(result[1], source[0]);
  });

  it('ignores ids that are not present (e.g. removed in another window)', () => {
    const result = applyOrder(items('a', 'b'), ['b', 'ghost', 'a']);
    assert.deepEqual(ids(result), ['b', 'a']);
  });

  it('appends items missing from the order, keeping their relative order', () => {
    // Only 'c' was named; 'a' and 'b' were added elsewhere and must survive.
    const result = applyOrder(items('a', 'b', 'c'), ['c']);
    assert.deepEqual(ids(result), ['c', 'a', 'b']);
  });

  it('returns the original order when the requested order is empty', () => {
    const result = applyOrder(items('a', 'b', 'c'), []);
    assert.deepEqual(ids(result), ['a', 'b', 'c']);
  });

  it('handles an empty item list', () => {
    assert.deepEqual(applyOrder(items(), ['a']), []);
  });

  it('drops duplicate ids after the first occurrence', () => {
    const result = applyOrder(items('a', 'b'), ['a', 'a', 'b']);
    assert.deepEqual(ids(result), ['a', 'b']);
  });
});

describe('applyMove', () => {
  it('reorders and assigns the moved item to the folder', () => {
    const result = applyMove(items('a', 'b', 'c'), 'c', 'f1', ['c', 'a', 'b']);
    assert.deepEqual(ids(result), ['c', 'a', 'b']);
    assert.equal(result[0].folderId, 'f1');
    assert.equal(result[1].folderId, undefined);
  });

  it('moves an item back to the top level with null', () => {
    const source: Item[] = [
      { id: 'a', folderId: 'f1' },
      { id: 'b', folderId: 'f1' },
    ];
    const result = applyMove(source, 'a', null, ['b', 'a']);
    assert.deepEqual(ids(result), ['b', 'a']);
    assert.equal(result[1].folderId, undefined);
    assert.equal(result[0].folderId, 'f1');
  });

  it('leaves other items untouched (same references)', () => {
    const source = items('a', 'b');
    const result = applyMove(source, 'a', 'f1', ['a', 'b']);
    assert.equal(result[1], source[1]);
    assert.notEqual(result[0], source[0]);
  });
});
