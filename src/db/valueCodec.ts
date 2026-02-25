import { Scalar } from '../types';

export function toScalar(value: unknown): Scalar {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function isLockedSqliteError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as { code?: string; message?: string };
  return err.code === 'SQLITE_BUSY' || (err.message ?? '').toLowerCase().includes('database is locked');
}
