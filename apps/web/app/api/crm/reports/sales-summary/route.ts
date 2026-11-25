/**
 * GET /api/crm/reports/sales-summary — counters + pipeline/won totals.
 * docs/CONTRACTS.md §4.
 */
import { getSalesSummary } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  return ok(await getSalesSummary());
});
