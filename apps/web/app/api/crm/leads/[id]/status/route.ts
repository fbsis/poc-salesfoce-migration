/**
 * PATCH /api/crm/leads/[id]/status — { status: 'new' | 'contacted' | 'qualified' | 'closed' }
 * docs/CONTRACTS.md §4.
 */
import { idSchema, updateLeadStatus, updateLeadStatusSchema, validate } from '@poc/core';
import { requireCrmToken } from '../../../../../../lib/api/auth';
import { ok, readJsonBody, withRoute } from '../../../../../../lib/api/respond';

export const dynamic = 'force-dynamic';

type IdContext = { params: Promise<{ id: string }> };

export const PATCH = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  const input = validate(updateLeadStatusSchema, await readJsonBody(request));
  return ok(await updateLeadStatus(validate(idSchema, id), input.status));
});
