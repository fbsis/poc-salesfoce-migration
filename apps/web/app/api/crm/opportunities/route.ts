/**
 * GET  /api/crm/opportunities — list (`search, stage, account_id, limit, offset`)
 * POST /api/crm/opportunities — create ({ name, account_id?, stage?, amount?, close_date?, owner_name?, probability? })
 * docs/CONTRACTS.md §4.
 */
import {
  createOpportunity,
  createOpportunitySchema,
  listOpportunities,
  validate,
} from '@poc/core';
import { requireCrmToken } from '../../../../lib/api/auth';
import { created, list, readJsonBody, withRoute } from '../../../../lib/api/respond';
import { listOpportunitiesParamsSchema, parseQuery } from '../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(listOpportunitiesParamsSchema, request);
  return list(await listOpportunities(params));
});

export const POST = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const input = validate(createOpportunitySchema, await readJsonBody(request));
  return created(await createOpportunity(input));
});
