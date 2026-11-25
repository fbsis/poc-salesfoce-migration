/**
 * Typed application errors. Every service throws `AppError` for expected
 * failures; the HTTP API maps them with `toErrorResponse` (docs/CONTRACTS.md §4).
 */

export type AppErrorCode =
  | 'validation_error'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'internal';

export const APP_ERROR_STATUS: Record<AppErrorCode, number> = {
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  internal: 500,
};

export class AppError extends Error {
  code: AppErrorCode;
  status: number;
  details?: unknown;

  constructor(
    codeOrInit: AppErrorCode | { code: AppErrorCode; message?: string; details?: unknown },
    message?: string,
    details?: unknown,
  ) {
    const code = typeof codeOrInit === 'string' ? codeOrInit : codeOrInit.code;
    const text =
      typeof codeOrInit === 'string'
        ? (message ?? code)
        : (codeOrInit.message ?? codeOrInit.code);
    const payload = typeof codeOrInit === 'string' ? details : codeOrInit.details;
    super(text);
    this.name = 'AppError';
    this.code = code;
    this.status = APP_ERROR_STATUS[code] ?? 500;
    this.details = payload;
    // Keep `instanceof` working when compiled down to ES5-era targets.
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export interface ErrorResponse {
  error: { code: string; message: string; details?: unknown };
}

export function toErrorResponse(e: unknown): ErrorResponse {
  if (isAppError(e)) {
    return {
      error: {
        code: e.code,
        message: e.message,
        ...(e.details === undefined ? {} : { details: e.details }),
      },
    };
  }
  // Unexpected failure: log it, but never leak internals to the caller.
  console.error('[core] unexpected error', e);
  return { error: { code: 'internal', message: 'Internal server error' } };
}

// ------------------------------------------------------------------ helpers

export function notFound(entity: string, id: string): AppError {
  return new AppError('not_found', `${entity} ${id} not found`);
}

export function validationError(message: string, details?: unknown): AppError {
  return new AppError('validation_error', message, details);
}

export function conflict(message: string, details?: unknown): AppError {
  return new AppError('conflict', message, details);
}
