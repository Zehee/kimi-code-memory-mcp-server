/**
 * Unified storage error taxonomy.
 *
 * Every persistence failure is expressed as one of four stable classes so
 * callers (MCP tools, HTTP handlers) can map it to a precise response
 * instead of leaking raw errno strings. `toStorageError` converts unknown
 * NodeJS errors (ENOENT, EACCES, EPERM, …) into the taxonomy.
 */

export type StorageErrorCode =
  | 'not_found'
  | 'permission_denied'
  | 'corrupt_data'
  | 'unsupported_version';

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly statusCode: number;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.statusCode =
      code === 'not_found'
        ? 404
        : code === 'permission_denied'
          ? 403
          : code === 'unsupported_version'
            ? 400
            : 500;
  }
}

export class NotFoundError extends StorageError {
  constructor(what: string) {
    super('not_found', `${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class PermissionDeniedError extends StorageError {
  constructor(what: string, cause?: unknown) {
    super(
      'permission_denied',
      `Permission denied for ${what}${cause instanceof Error ? `: ${cause.message}` : ''}`,
    );
    this.name = 'PermissionDeniedError';
  }
}

export class CorruptDataError extends StorageError {
  constructor(what: string, reason: string) {
    super('corrupt_data', `${what} is corrupted: ${reason}`);
    this.name = 'CorruptDataError';
  }
}

export class UnsupportedVersionError extends StorageError {
  constructor(what: string, found: unknown, expected: string) {
    super('unsupported_version', `${what} has unsupported version ${JSON.stringify(found)} (expected ${expected})`);
    this.name = 'UnsupportedVersionError';
  }
}

const ERRNO_MAP: Record<string, StorageErrorCode> = {
  ENOENT: 'not_found',
  ENOTDIR: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EISDIR: 'corrupt_data',
  EBUSY: 'permission_denied',
};

/**
 * Convert an unknown error into the taxonomy. `alreadyTaxonomic` errors
 * (anything extending StorageError and the existing domain errors that carry
 * a `code`) pass through unchanged.
 */
export function toStorageError(err: unknown, context: string): StorageError {
  if (err instanceof StorageError) return err;
  if (err instanceof Error) {
    const anyErr = err as NodeJS.ErrnoException;
    const mapped = anyErr.code ? ERRNO_MAP[anyErr.code] : undefined;
    if (mapped) {
      return new StorageError(mapped, `${context}: ${anyErr.message} (${anyErr.code})`);
    }
    // Corrupt-data domain errors thrown by the stores keep their meaning.
    if (
      err.name === 'MemoryCorruptError' ||
      err.name === 'FrontmatterParseError' ||
      err.name === 'SearchViewCorruptError' ||
      err.name === 'RefinedCorruptRowError'
    ) {
      return new CorruptDataError(context, err.message);
    }
    return new StorageError('corrupt_data', `${context}: ${err.message}`);
  }
  return new StorageError('corrupt_data', `${context}: ${String(err)}`);
}

/** Map a thrown error to an HTTP status + stable code for JSON responses. */
export function errorToHttpStatus(err: unknown): {
  statusCode: number;
  code: StorageErrorCode | 'internal_error';
  message: string;
} {
  const storage = toStorageError(err, 'request');
  return {
    statusCode: storage.statusCode,
    code: storage.code,
    message: storage.message,
  };
}
