/**
 * Query-param and body schemas for the internal CRM API (docs/CONTRACTS.md §4).
 *
 * The create/update/list schemas are re-exported from `@poc/core` so the API
 * and the service layer validate with exactly the same rules — no duplicated
 * constraints, no drift. Only the query-string parsing helpers and the handful
 * of params the core does not already model live here.
 */
import { z } from 'zod';
import {
  AppError,
  limitSchema,
  listAccountsParamsSchema,
  listContactsParamsSchema,
  listLeadsParamsSchema,
  listOpportunitiesParamsSchema,
  validate,
} from '@poc/core';

export {
  // create / update bodies
  createAccountSchema,
  updateAccountSchema,
  createContactSchema,
  updateContactSchema,
  createOpportunitySchema,
  updateOpportunitySchema,
  createLeadSchema,
  updateLeadSchema,
  updateLeadStatusSchema,
  // list params
  listAccountsParamsSchema,
  listContactsParamsSchema,
  listOpportunitiesParamsSchema,
  listLeadsParamsSchema,
  listCdcEventsParamsSchema,
  leadSummaryParamsSchema,
  // shared primitives
  idSchema,
  limitSchema,
  offsetSchema,
  searchSchema,
  entitySourceSchema,
  opportunityStageSchema,
  leadStatusSchema,
  leadSourceSchema,
  cdcEventStatusSchema,
} from '@poc/core';

// ------------------------------------------------------------ route queries

/** `GET /api/crm/sync/runs?limit=` — the only param listSyncRuns accepts. */
export const listSyncRunsParamsSchema = z.object({ limit: limitSchema });

// ----------------------------------------------------------------- helpers

/**
 * The request's query string as a flat `Record<string, string>`.
 * Repeated keys keep the first value (matching typical REST behaviour) and
 * blank values (`?status=`) are dropped, so an omitted optional filter and an
 * empty one behave the same instead of producing a spurious 400.
 */
export function queryObject(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in params) continue;
    if (value.trim() === '') continue;
    params[key] = value;
  }
  return params;
}

/**
 * Parse the query string with `schema`, throwing
 * `AppError('validation_error')` with `{ field: message }` details.
 */
export function parseQuery<S extends z.ZodTypeAny>(schema: S, request: Request): z.infer<S> {
  return validate(schema, queryObject(request));
}

/**
 * Reject an all-undefined PATCH body. Without this the service layer would
 * silently no-op and return 200 for `{}`, hiding client bugs.
 */
export function requireNonEmptyPatch(body: unknown): void {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError('validation_error', 'Request body must be a JSON object', {
      _: 'expected a JSON object',
    });
  }
  const hasField = Object.values(body as Record<string, unknown>).some(
    (value) => value !== undefined,
  );
  if (!hasField) {
    throw new AppError('validation_error', 'at least one field is required', {
      _: 'the patch body is empty',
    });
  }
}
