/**
 * GET   /api/crm/accounts/[id]  — id is a local uuid **or** a Salesforce id
 * PATCH /api/crm/accounts/[id]  — partial update
 * docs/CONTRACTS.md §4.
 */
import {
  getAccount,
  updateAccount,
  updateAccountSchema,
  validate,
  idSchema,
} from '@poc/core';
import { requireCrmToken } from '../../../../../lib/api/auth';
import { ok, readJsonBody, withRoute } from '../../../../../lib/api/respond';
import { requireNonEmptyPatch } from '../../../../../lib/api/schemas';

export const dynamic = 'force-dynamic';

type IdContext = { params: Promise<{ id: string }> };

export const GET = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  return ok(await getAccount(validate(idSchema, id)));
});

export const PATCH = withRoute<IdContext>(async (request, context) => {
  requireCrmToken(request);
  const { id } = await context.params;
  const body = await readJsonBody(request);
  requireNonEmptyPatch(body);
  const input = validate(updateAccountSchema, body);
  return ok(await updateAccount(validate(idSchema, id), input));
});
