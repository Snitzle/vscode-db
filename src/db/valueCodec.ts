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

  // Covers Buffer too (Buffer extends Uint8Array); node:sqlite returns BLOBs
  // as plain Uint8Array.
  if (value instanceof Uint8Array) {
    return `0x${Buffer.from(value).toString('hex')}`;
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

  // sqlite3 used code === 'SQLITE_BUSY'; node:sqlite throws ERR_SQLITE_ERROR
  // with the numeric SQLite errcode (5 = SQLITE_BUSY). The message check keeps
  // covering both.
  const err = error as { code?: string; errcode?: number; message?: string };
  return (
    err.code === 'SQLITE_BUSY' ||
    err.errcode === 5 ||
    (err.message ?? '').toLowerCase().includes('database is locked')
  );
}
