/**
 * GET /api/crm/sync/runs?limit= — most recent sync runs (newest first).
 * docs/CONTRACTS.md §4. Non-paged collection: `{ data: [...] }`.
 */
import { listSyncRuns } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';
import { listSyncRunsParamsSchema, parseQuery } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const { limit } = parseQuery(listSyncRunsParamsSchema, request);
  return ok(await listSyncRuns(limit));
});
