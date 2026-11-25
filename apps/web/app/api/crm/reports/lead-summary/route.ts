/**
 * GET /api/crm/reports/lead-summary?since=ISO — totals, byStatus, bySource,
 * newToday and the latest leads. docs/CONTRACTS.md §4.
 */
import { getLeadSummary } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';
import { leadSummaryParamsSchema, parseQuery } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(leadSummaryParamsSchema, request);
  return ok(await getLeadSummary(params));
});
