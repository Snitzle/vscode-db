import { WritableKeyInfo } from '../types';

export interface UniqueIndexCandidate {
  columns: string[];
  nullable: boolean;
}

export function chooseWritableKey(params: {
  primaryKeyColumns: string[];
  uniqueIndexCandidates: UniqueIndexCandidate[];
  allowRowId: boolean;
}): WritableKeyInfo {
  if (params.primaryKeyColumns.length > 0) {
    return { kind: 'primary', columns: [...params.primaryKeyColumns] };
  }

  const firstSafeUnique = params.uniqueIndexCandidates.find(
    (candidate) => candidate.columns.length > 0 && !candidate.nullable,
  );

  if (firstSafeUnique) {
    return { kind: 'unique', columns: [...firstSafeUnique.columns] };
  }

  if (params.allowRowId) {
    return { kind: 'rowid', columns: ['rowid'] };
  }

  return {
    kind: 'none',
    columns: [],
    reason: 'No primary key or non-null unique index was found. Editing and deleting are disabled.',
  };
}
