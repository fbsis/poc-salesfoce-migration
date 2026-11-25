/**
 * GET /api/crm/sync/status — bulk run, checkpoints, CDC counts and lag.
 * docs/CONTRACTS.md §4.
 */
import { getSyncStatus } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  return ok(await getSyncStatus());
});
