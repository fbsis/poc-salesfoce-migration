/**
 * GET /api/crm/leads/[id] — uuid or Salesforce id
 * docs/CONTRACTS.md §4.
 */
import { getLead, idSchema, validate } from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, withRoute } from '../../../../../lib/api/respond';

export const dynamic = 'force-dynamic';

type IdContext = { params: Promise<{ id: string }> };

export const GET = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  return ok(await getLead(validate(idSchema, id)));
});
