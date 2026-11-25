/**
 * GET   /api/crm/opportunities/[id] — uuid or Salesforce id
 * PATCH /api/crm/opportunities/[id] — partial update
 * docs/CONTRACTS.md §4.
 */
import {
  getOpportunity,
  idSchema,
  updateOpportunity,
  updateOpportunitySchema,
  validate,
} from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, readJsonBody, withRoute } from '../../../../../lib/api/respond';
import { requireNonEmptyPatch } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

type IdContext = { params: Promise<{ id: string }> };

export const GET = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  return ok(await getOpportunity(validate(idSchema, id)));
});

export const PATCH = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  const body = await readJsonBody(request);
  requireNonEmptyPatch(body);
  const input = validate(updateOpportunitySchema, body);
  return ok(await updateOpportunity(validate(idSchema, id), input));
});
