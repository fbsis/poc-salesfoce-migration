/**
 * GET /api/crm/sync/events?limit=&status= — recent CDC events (newest first).
 * docs/CONTRACTS.md §4. Non-paged collection: `{ data: [...] }`.
 */
import { listCdcEvents } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';
import { listCdcEventsParamsSchema, parseQuery } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

export const GET = withRoute(async (request: Request) => {
  requireCrmToken(request);
  const params = parseQuery(listCdcEventsParamsSchema, request);
  return ok(await listCdcEvents(params));
});
