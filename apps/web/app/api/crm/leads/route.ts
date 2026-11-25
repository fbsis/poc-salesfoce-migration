/**
 * GET /api/crm/leads — list (`search, status, source, created_since, limit, offset`)
 * docs/CONTRACTS.md §4. Mutations go through the dedicated status route.
 */
import { listLeads } from '@poc/core';
import { requireCrmToken } from '../../../../lib/api/auth';
import { list, withRoute } from '../../../../lib/api/respond';
import { listLeadsParamsSchema, parseQuery } from '../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(listLeadsParamsSchema, request);
  return list(await listLeads(params));
});
