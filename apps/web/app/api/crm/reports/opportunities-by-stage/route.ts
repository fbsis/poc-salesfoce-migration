/**
 * GET /api/crm/reports/opportunities-by-stage — [{ stage, count, totalAmount }].
 * docs/CONTRACTS.md §4.
 */
import { getOpportunitiesByStage } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  return ok(await getOpportunitiesByStage());
});
