/**
 * `@poc/core` public surface — everything the web app, the worker, the HTTP API
 * and the MCP server are allowed to import.
 *
 * All DB access lives behind these modules (docs/CONTRACTS.md §0.7).
 */

// ---------------------------------------------------------------- foundation
export * from './types';
export { AppError, isAppError, toErrorResponse, notFound, validationError, conflict } from './errors';
export type { AppErrorCode, ErrorResponse } from './errors';
export {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  normalizeLimit,
  normalizeOffset,
  normalizePagination,
  toPaged,
} from './pagination';
export type { Page } from './pagination';
export { isUuid, isSalesforceId, classifyId, SALESFORCE_PREFIX } from './ids';
export type { IdKind } from './ids';

// ---------------------------------------------------------------- validation
export * from './validation';

// ------------------------------------------------------------------- database
export { getPool, query, queryOne, withTransaction, closePool } from './db';

// ------------------------------------------------------------------- services
export * from './accounts';
export * from './contacts';
export * from './opportunities';
export * from './leads';
export * from './reporting';
export * from './sync';
export * from './ingest';
